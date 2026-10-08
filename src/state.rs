use crate::{
    backend::BackendRegistry,
    config::Config,
    docker::DockerExecutor,
    model::{MetricSample, ScalingAction, ScalingDecision, WorkloadMetric},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, HashMap, VecDeque},
    hash::{Hash, Hasher},
    io,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    fs,
    io::AsyncWriteExt,
    sync::{Mutex, RwLock},
    task::JoinHandle,
    time::MissedTickBehavior,
};
use tracing::{info, warn};
use uuid::Uuid;

const STATE_SCHEMA_VERSION: u32 = 1;
const DEFAULT_STATE_PATH: &str = "data/fluxscale-state.json";
const STATE_PATH_ENV: &str = "FLUXSCALE_STATE_PATH";
const DECISION_HISTORY_LIMIT: usize = 200;
const STALE_SERVICE_TTL_ENV: &str = "FLUXSCALE_STALE_SERVICE_TTL_SECONDS";
const MAINTENANCE_INTERVAL_ENV: &str = "FLUXSCALE_MAINTENANCE_INTERVAL_SECONDS";
const DEFAULT_STALE_SERVICE_TTL_SECONDS: u64 = 24 * 60 * 60;
const MIN_STALE_SERVICE_TTL_SECONDS: u64 = 5 * 60;
const MAX_STALE_SERVICE_TTL_SECONDS: u64 = 30 * 24 * 60 * 60;
const DEFAULT_MAINTENANCE_INTERVAL_SECONDS: u64 = 60;
const MIN_MAINTENANCE_INTERVAL_SECONDS: u64 = 1;
const MAX_MAINTENANCE_INTERVAL_SECONDS: u64 = 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceRuntime {
    pub sample: MetricSample,
    pub decision: ScalingDecision,
    #[serde(default)]
    pub workloads: Vec<WorkloadMetric>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ServiceRuntime {
    #[serde(default)]
    pub policy: Option<ServicePolicy>,
    #[serde(default)]
    pub metrics: VecDeque<MetricSample>,
    #[serde(default)]
    pub decisions: VecDeque<ScalingDecision>,
    #[serde(default)]
    pub last_change_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub instances: HashMap<String, InstanceRuntime>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ServicePolicy {
    pub version: u64,
    pub enabled: bool,
    pub min_replicas: u32,
    pub max_replicas: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestoreSource {
    Empty,
    Primary,
    Backup,
}

impl RestoreSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::Primary => "primary",
            Self::Backup => "backup",
        }
    }
}

#[derive(Debug, Clone)]
pub struct RestoreReport {
    pub source: RestoreSource,
    pub snapshot_saved_at: Option<DateTime<Utc>>,
    pub services: usize,
    pub metric_samples: usize,
    pub decisions: usize,
    pub quarantined_file: Option<PathBuf>,
}

impl RestoreReport {
    fn empty(quarantined_file: Option<PathBuf>) -> Self {
        Self {
            source: RestoreSource::Empty,
            snapshot_saved_at: None,
            services: 0,
            metric_samples: 0,
            decisions: 0,
            quarantined_file,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PersistenceHealth {
    pub state_schema_version: u32,
    pub restore_source: RestoreSource,
    pub restored_at: Option<DateTime<Utc>>,
    pub restored_services: usize,
    pub restored_metric_samples: usize,
    pub restored_decisions: usize,
    pub last_successful_save_at: Option<DateTime<Utc>>,
    pub last_save_error: Option<String>,
    pub last_cleanup_at: Option<DateTime<Utc>>,
    pub services_removed_total: u64,
    pub stale_service_ttl_seconds: u64,
    pub maintenance_interval_seconds: u64,
}

#[derive(Debug, Clone)]
pub struct CleanupReport {
    pub checked_at: DateTime<Utc>,
    pub candidates: usize,
    pub removed: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PersistedState {
    schema_version: u32,
    saved_at: DateTime<Utc>,
    #[serde(default)]
    services: HashMap<String, ServiceRuntime>,
}

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub services: Arc<RwLock<HashMap<String, ServiceRuntime>>>,
    pub registry: BackendRegistry,
    pub docker: DockerExecutor,
    persistence_path: Arc<PathBuf>,
    save_lock: Arc<Mutex<()>>,
    last_saved_signature: Arc<Mutex<Option<u64>>>,
    persistence_health: Arc<RwLock<PersistenceHealth>>,
    stale_service_ttl: Duration,
    maintenance_interval: Duration,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        let persistence_path = std::env::var_os(STATE_PATH_ENV)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_STATE_PATH));

        Self::with_persistence_path(config, persistence_path)
    }

    pub fn with_persistence_path(config: Config, persistence_path: impl Into<PathBuf>) -> Self {
        let registry = BackendRegistry::default();
        let docker = DockerExecutor::new(config.docker.clone(), registry.clone());
        let stale_service_ttl = env_duration(
            STALE_SERVICE_TTL_ENV,
            DEFAULT_STALE_SERVICE_TTL_SECONDS,
            MIN_STALE_SERVICE_TTL_SECONDS,
            MAX_STALE_SERVICE_TTL_SECONDS,
        );
        let maintenance_interval = env_duration(
            MAINTENANCE_INTERVAL_ENV,
            DEFAULT_MAINTENANCE_INTERVAL_SECONDS,
            MIN_MAINTENANCE_INTERVAL_SECONDS,
            MAX_MAINTENANCE_INTERVAL_SECONDS,
        );

        Self {
            config: Arc::new(config),
            services: Arc::new(RwLock::new(HashMap::new())),
            registry,
            docker,
            persistence_path: Arc::new(persistence_path.into()),
            save_lock: Arc::new(Mutex::new(())),
            last_saved_signature: Arc::new(Mutex::new(None)),
            persistence_health: Arc::new(RwLock::new(PersistenceHealth {
                state_schema_version: STATE_SCHEMA_VERSION,
                restore_source: RestoreSource::Empty,
                restored_at: None,
                restored_services: 0,
                restored_metric_samples: 0,
                restored_decisions: 0,
                last_successful_save_at: None,
                last_save_error: None,
                last_cleanup_at: None,
                services_removed_total: 0,
                stale_service_ttl_seconds: stale_service_ttl.as_secs(),
                maintenance_interval_seconds: maintenance_interval.as_secs(),
            })),
            stale_service_ttl,
            maintenance_interval,
        }
    }

    pub fn persistence_path(&self) -> &Path {
        self.persistence_path.as_ref().as_path()
    }

    pub async fn persistence_health(&self) -> PersistenceHealth {
        self.persistence_health.read().await.clone()
    }

    pub fn stale_service_ttl(&self) -> Duration {
        self.stale_service_ttl
    }

    pub fn maintenance_interval(&self) -> Duration {
        self.maintenance_interval
    }

    pub async fn restore(&self) -> io::Result<RestoreReport> {
        let primary = self.persistence_path();
        let backup = backup_path(primary);

        match read_snapshot(primary).await {
            Ok(Some(snapshot)) => {
                let report = self
                    .install_snapshot(snapshot, RestoreSource::Primary, None)
                    .await;
                return Ok(self.record_restore(report).await);
            }
            Ok(None) => {}
            Err(error) if error.kind() == io::ErrorKind::InvalidData => {
                let quarantined = quarantine(primary).await?;

                warn!(
                    path = %primary.display(),
                    quarantined = %quarantined.display(),
                    error = %error,
                    "invalid FluxScale state was quarantined"
                );

                match read_snapshot(&backup).await {
                    Ok(Some(snapshot)) => {
                        let report = self
                            .install_snapshot(snapshot, RestoreSource::Backup, Some(quarantined))
                            .await;
                        return Ok(self.record_restore(report).await);
                    }
                    Ok(None) => {}
                    Err(backup_error) if backup_error.kind() == io::ErrorKind::InvalidData => {
                        let backup_quarantine = quarantine(&backup).await?;
                        warn!(
                            path = %backup.display(),
                            quarantined = %backup_quarantine.display(),
                            error = %backup_error,
                            "invalid FluxScale backup state was quarantined"
                        );
                    }
                    Err(backup_error) => return Err(backup_error),
                }

                let report = RestoreReport::empty(Some(quarantined));
                return Ok(self.record_restore(report).await);
            }
            Err(error) => return Err(error),
        }

        match read_snapshot(&backup).await {
            Ok(Some(snapshot)) => {
                let report = self
                    .install_snapshot(snapshot, RestoreSource::Backup, None)
                    .await;
                return Ok(self.record_restore(report).await);
            }
            Ok(None) => {}
            Err(error) if error.kind() == io::ErrorKind::InvalidData => {
                let quarantined = quarantine(&backup).await?;
                warn!(
                    path = %backup.display(),
                    quarantined = %quarantined.display(),
                    error = %error,
                    "invalid FluxScale backup state was quarantined"
                );

                let report = RestoreReport::empty(Some(quarantined));
                return Ok(self.record_restore(report).await);
            }
            Err(error) => return Err(error),
        }

        let report = RestoreReport::empty(None);
        Ok(self.record_restore(report).await)
    }

    pub fn spawn_persistence_task(&self, interval: Duration) -> JoinHandle<()> {
        let state = self.clone();

        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

            loop {
                ticker.tick().await;

                match state.persist_if_changed().await {
                    Ok(true) => info!(
                        path = %state.persistence_path().display(),
                        "FluxScale runtime state persisted"
                    ),
                    Ok(false) => {}
                    Err(error) => warn!(
                        path = %state.persistence_path().display(),
                        error = %error,
                        "FluxScale runtime state persistence failed"
                    ),
                }
            }
        })
    }

    pub fn spawn_retention_task(&self) -> JoinHandle<()> {
        let state = self.clone();
        let interval = self.maintenance_interval;

        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

            loop {
                ticker.tick().await;
                let report = state.cleanup_stale_services().await;

                if !report.removed.is_empty() {
                    info!(
                        checked_at = %report.checked_at,
                        candidates = report.candidates,
                        removed = report.removed.len(),
                        services = ?report.removed,
                        "stale FluxScale service histories removed"
                    );
                }
            }
        })
    }

    pub async fn cleanup_stale_services(&self) -> CleanupReport {
        let checked_at = Utc::now();
        let stale_after = chrono::Duration::from_std(self.stale_service_ttl)
            .unwrap_or_else(|_| chrono::Duration::days(1));
        let cutoff = checked_at - stale_after;

        let candidates: Vec<String> = {
            let services = self.services.read().await;

            services
                .iter()
                .filter(|(_, runtime)| {
                    runtime.policy.is_none()
                        && last_activity(runtime).is_none_or(|timestamp| timestamp < cutoff)
                })
                .map(|(service, _)| service.clone())
                .collect()
        };

        let mut safe_to_remove = Vec::new();

        for service in &candidates {
            if self.registry.healthy_count(service).await == 0 {
                safe_to_remove.push(service.clone());
            }
        }

        let mut removed = Vec::new();

        if !safe_to_remove.is_empty() {
            let mut services = self.services.write().await;

            for service in safe_to_remove {
                let still_stale = services.get(&service).is_some_and(|runtime| {
                    runtime.policy.is_none()
                        && last_activity(runtime).is_none_or(|timestamp| timestamp < cutoff)
                });

                if still_stale && services.remove(&service).is_some() {
                    removed.push(service);
                }
            }
        }

        let mut health = self.persistence_health.write().await;
        health.last_cleanup_at = Some(checked_at);
        health.services_removed_total = health
            .services_removed_total
            .saturating_add(removed.len() as u64);

        CleanupReport {
            checked_at,
            candidates: candidates.len(),
            removed,
        }
    }

    pub async fn persist_if_changed(&self) -> io::Result<bool> {
        self.persist(false).await
    }

    pub async fn persist_now(&self) -> io::Result<()> {
        self.persist(true).await.map(|_| ())
    }

    async fn persist(&self, force: bool) -> io::Result<bool> {
        let _save_guard = self.save_lock.lock().await;
        let services = self.services.read().await.clone();
        let signature = state_signature(&services);

        if !force
            && *self.last_saved_signature.lock().await == Some(signature)
            && self
                .persistence_health
                .read()
                .await
                .last_save_error
                .is_none()
        {
            return Ok(false);
        }

        let snapshot = PersistedState {
            schema_version: STATE_SCHEMA_VERSION,
            saved_at: Utc::now(),
            services,
        };

        if let Err(error) = write_snapshot(self.persistence_path(), &snapshot).await {
            self.persistence_health.write().await.last_save_error = Some(error.to_string());
            return Err(error);
        }

        *self.last_saved_signature.lock().await = Some(signature);

        let mut health = self.persistence_health.write().await;
        health.last_successful_save_at = Some(snapshot.saved_at);
        health.last_save_error = None;

        Ok(true)
    }

    async fn record_restore(&self, report: RestoreReport) -> RestoreReport {
        let mut health = self.persistence_health.write().await;
        health.restore_source = report.source;
        health.restored_at = Some(Utc::now());
        health.restored_services = report.services;
        health.restored_metric_samples = report.metric_samples;
        health.restored_decisions = report.decisions;
        health.last_successful_save_at = report.snapshot_saved_at;
        report
    }

    async fn install_snapshot(
        &self,
        mut snapshot: PersistedState,
        source: RestoreSource,
        quarantined_file: Option<PathBuf>,
    ) -> RestoreReport {
        let snapshot_saved_at = snapshot.saved_at;

        sanitize_services(&mut snapshot.services, self.config.scaling.history_limit);

        let services = snapshot.services.len();
        let metric_samples = snapshot
            .services
            .values()
            .map(|runtime| runtime.metrics.len())
            .sum();
        let decisions = snapshot
            .services
            .values()
            .map(|runtime| runtime.decisions.len())
            .sum();

        *self.services.write().await = snapshot.services;

        RestoreReport {
            source,
            snapshot_saved_at: Some(snapshot_saved_at),
            services,
            metric_samples,
            decisions,
            quarantined_file,
        }
    }
}

async fn read_snapshot(path: &Path) -> io::Result<Option<PersistedState>> {
    let bytes = match fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };

    let snapshot: PersistedState = serde_json::from_slice(&bytes).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("could not decode {}: {error}", path.display()),
        )
    })?;

    if snapshot.schema_version != STATE_SCHEMA_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "unsupported state schema {} in {}; expected {}",
                snapshot.schema_version,
                path.display(),
                STATE_SCHEMA_VERSION
            ),
        ));
    }

    Ok(Some(snapshot))
}

async fn write_snapshot(path: &Path, snapshot: &PersistedState) -> io::Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).await?;
    }

    let bytes = serde_json::to_vec_pretty(snapshot).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("could not encode runtime state: {error}"),
        )
    })?;

    let temporary = temporary_path(path);
    let backup = backup_path(path);
    let mut file = fs::File::create(&temporary).await?;

    file.write_all(&bytes).await?;
    file.flush().await?;
    file.sync_all().await?;
    drop(file);

    let primary_exists = fs::metadata(path).await.is_ok();

    if primary_exists {
        match fs::remove_file(&backup).await {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                let _ = fs::remove_file(&temporary).await;
                return Err(error);
            }
        }

        if let Err(error) = fs::rename(path, &backup).await {
            let _ = fs::remove_file(&temporary).await;
            return Err(error);
        }
    }

    if let Err(error) = fs::rename(&temporary, path).await {
        if primary_exists {
            let _ = fs::rename(&backup, path).await;
        }

        let _ = fs::remove_file(&temporary).await;
        return Err(error);
    }

    Ok(())
}

async fn quarantine(path: &Path) -> io::Result<PathBuf> {
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("fluxscale-state.json");
    let timestamp = Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    let quarantined = path.with_file_name(format!("{filename}.corrupt-{timestamp}"));

    fs::rename(path, &quarantined).await?;
    Ok(quarantined)
}

fn backup_path(path: &Path) -> PathBuf {
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("fluxscale-state.json");

    path.with_file_name(format!("{filename}.bak"))
}

fn temporary_path(path: &Path) -> PathBuf {
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("fluxscale-state.json");

    path.with_file_name(format!("{filename}.tmp-{}", Uuid::new_v4()))
}

fn sanitize_services(services: &mut HashMap<String, ServiceRuntime>, history_limit: usize) {
    services.retain(|service, runtime| {
        if service.trim().is_empty() {
            return false;
        }

        runtime.metrics.retain(valid_metric);
        runtime
            .decisions
            .retain(|decision| valid_decision(service, decision));
        runtime.instances.retain(|instance, value| {
            !instance.trim().is_empty()
                && valid_metric(&value.sample)
                && valid_decision(service, &value.decision)
        });

        while runtime.metrics.len() > history_limit {
            runtime.metrics.pop_front();
        }

        while runtime.decisions.len() > DECISION_HISTORY_LIMIT {
            runtime.decisions.pop_front();
        }

        !runtime.metrics.is_empty() || !runtime.decisions.is_empty() || runtime.policy.is_some()
    });
}

fn valid_metric(sample: &MetricSample) -> bool {
    sample.requests_per_second.is_finite()
        && sample.requests_per_second >= 0.0
        && sample.p95_latency_ms.is_finite()
        && sample.p95_latency_ms >= 0.0
        && sample.error_rate.is_finite()
        && (0.0..=1.0).contains(&sample.error_rate)
        && sample.cpu_percent.is_finite()
        && (0.0..=100.0).contains(&sample.cpu_percent)
        && sample.memory_percent.is_finite()
        && (0.0..=100.0).contains(&sample.memory_percent)
        && sample.current_replicas > 0
}

fn valid_decision(service: &str, decision: &ScalingDecision) -> bool {
    decision.service == service
        && decision.current_replicas > 0
        && decision.desired_replicas > 0
        && decision.current_rps.is_finite()
        && decision.current_rps >= 0.0
        && decision.predicted_rps.is_finite()
        && decision.predicted_rps >= 0.0
}

fn last_activity(runtime: &ServiceRuntime) -> Option<DateTime<Utc>> {
    runtime
        .metrics
        .back()
        .map(|sample| sample.timestamp)
        .into_iter()
        .chain(runtime.decisions.back().map(|decision| decision.timestamp))
        .max()
}

fn env_duration(name: &str, fallback: u64, minimum: u64, maximum: u64) -> Duration {
    let seconds = std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(fallback)
        .clamp(minimum, maximum);

    Duration::from_secs(seconds)
}

fn state_signature(services: &HashMap<String, ServiceRuntime>) -> u64 {
    let mut names: Vec<&String> = services.keys().collect();
    names.sort();

    let mut hasher = DefaultHasher::new();
    STATE_SCHEMA_VERSION.hash(&mut hasher);

    for name in names {
        name.hash(&mut hasher);
        let runtime = &services[name];
        if let Some(policy) = &runtime.policy {
            policy.version.hash(&mut hasher);
            policy.enabled.hash(&mut hasher);
            policy.min_replicas.hash(&mut hasher);
            policy.max_replicas.hash(&mut hasher);
        }

        for sample in &runtime.metrics {
            sample.timestamp.hash(&mut hasher);
            sample.requests_per_second.to_bits().hash(&mut hasher);
            sample.active_requests.hash(&mut hasher);
            sample.p95_latency_ms.to_bits().hash(&mut hasher);
            sample.error_rate.to_bits().hash(&mut hasher);
            sample.cpu_percent.to_bits().hash(&mut hasher);
            sample.memory_percent.to_bits().hash(&mut hasher);
            sample.current_replicas.hash(&mut hasher);
        }

        for decision in &runtime.decisions {
            decision.id.hash(&mut hasher);
            decision.timestamp.hash(&mut hasher);
            let action_tag = match decision.action {
                ScalingAction::ScaleUp => 1_u8,
                ScalingAction::ScaleDown => 2_u8,
                ScalingAction::Hold => 3_u8,
            };
            action_tag.hash(&mut hasher);
            decision.current_replicas.hash(&mut hasher);
            decision.desired_replicas.hash(&mut hasher);
            decision.current_rps.to_bits().hash(&mut hasher);
            decision.predicted_rps.to_bits().hash(&mut hasher);
            decision.prediction_horizon_seconds.hash(&mut hasher);
            decision.reasons.hash(&mut hasher);
        }

        let mut instances: Vec<_> = runtime.instances.iter().collect();
        instances.sort_by(|(left, _), (right, _)| left.cmp(right));

        for (instance, value) in instances {
            instance.hash(&mut hasher);
            value.sample.timestamp.hash(&mut hasher);
            value.sample.requests_per_second.to_bits().hash(&mut hasher);
            value.sample.active_requests.hash(&mut hasher);
            value.sample.p95_latency_ms.to_bits().hash(&mut hasher);
            value.sample.error_rate.to_bits().hash(&mut hasher);
            value.sample.cpu_percent.to_bits().hash(&mut hasher);
            value.sample.memory_percent.to_bits().hash(&mut hasher);
            value.sample.current_replicas.hash(&mut hasher);
            value.decision.id.hash(&mut hasher);
            serde_json::to_string(&value.workloads)
                .unwrap_or_default()
                .hash(&mut hasher);
        }

        runtime.last_change_at.hash(&mut hasher);
    }

    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("fluxscale-{name}-{}.json", Uuid::new_v4()))
    }

    fn sample(rps: f64) -> MetricSample {
        MetricSample {
            timestamp: Utc::now(),
            requests_per_second: rps,
            active_requests: 4,
            p95_latency_ms: 100.0,
            error_rate: 0.0,
            cpu_percent: 40.0,
            memory_percent: 30.0,
            current_replicas: 1,
        }
    }

    fn decision(service: &str, rps: f64) -> ScalingDecision {
        ScalingDecision {
            id: Uuid::new_v4(),
            service: service.to_string(),
            timestamp: Utc::now(),
            action: ScalingAction::Hold,
            current_replicas: 1,
            desired_replicas: 1,
            current_rps: rps,
            predicted_rps: rps,
            prediction_horizon_seconds: 10,
            reasons: vec!["test decision".to_string()],
        }
    }

    async fn insert_sample(state: &AppState, service: &str, rps: f64) {
        let mut services = state.services.write().await;
        let runtime = services.entry(service.to_string()).or_default();
        runtime.metrics.push_back(sample(rps));
        runtime.decisions.push_back(decision(service, rps));
        runtime.last_change_at = Some(Utc::now());
    }

    async fn clean(path: &Path) {
        let _ = fs::remove_file(path).await;
        let _ = fs::remove_file(backup_path(path)).await;
    }

    #[tokio::test]
    async fn runtime_state_survives_restart() {
        let path = test_path("roundtrip");
        let first = AppState::with_persistence_path(Config::default(), &path);
        insert_sample(&first, "payment-api", 420.0).await;
        first.persist_now().await.unwrap();

        let second = AppState::with_persistence_path(Config::default(), &path);
        let report = second.restore().await.unwrap();

        assert_eq!(report.source, RestoreSource::Primary);
        assert_eq!(report.services, 1);
        assert_eq!(report.metric_samples, 1);
        assert_eq!(report.decisions, 1);

        let health = second.persistence_health().await;
        assert_eq!(health.restore_source, RestoreSource::Primary);
        assert_eq!(health.restored_services, 1);
        assert_eq!(health.restored_metric_samples, 1);

        let services = second.services.read().await;
        let runtime = services.get("payment-api").unwrap();
        assert_eq!(runtime.metrics.back().unwrap().requests_per_second, 420.0);
        assert!(runtime.last_change_at.is_some());
        drop(services);

        clean(&path).await;
    }

    #[tokio::test]
    async fn instance_identity_survives_restart() {
        let path = test_path("instance-roundtrip");
        let first = AppState::with_persistence_path(Config::default(), &path);
        insert_sample(&first, "fleet-api", 250.0).await;

        {
            let mut services = first.services.write().await;
            let runtime = services.get_mut("fleet-api").unwrap();
            runtime.instances.insert(
                "replica-a".to_string(),
                InstanceRuntime {
                    workloads: vec![],
                    sample: sample(100.0),
                    decision: decision("fleet-api", 250.0),
                },
            );
        }

        first.persist_now().await.unwrap();
        let second = AppState::with_persistence_path(Config::default(), &path);
        second.restore().await.unwrap();

        let services = second.services.read().await;
        assert!(services["fleet-api"].instances.contains_key("replica-a"));
        drop(services);

        clean(&path).await;
    }

    #[tokio::test]
    async fn unchanged_state_does_not_write_again() {
        let path = test_path("unchanged");
        let state = AppState::with_persistence_path(Config::default(), &path);
        insert_sample(&state, "orders-api", 100.0).await;

        assert!(state.persist_if_changed().await.unwrap());
        assert!(!state.persist_if_changed().await.unwrap());

        clean(&path).await;
    }

    #[tokio::test]
    async fn failed_forced_save_retries_unchanged_state_after_recovery() {
        let directory = test_path("retry-save");
        let path = directory.join("state.json");
        let state = AppState::with_persistence_path(Config::default(), &path);
        state.persist_now().await.unwrap();
        clean(&path).await;
        fs::remove_dir(&directory).await.unwrap();
        fs::write(&directory, b"blocks checkpoint directory")
            .await
            .unwrap();
        assert!(state.persist_now().await.is_err());
        assert!(state.persistence_health().await.last_save_error.is_some());
        fs::remove_file(&directory).await.unwrap();
        assert!(state.persist_if_changed().await.unwrap());
        assert!(state.persistence_health().await.last_save_error.is_none());
        clean(&path).await;
        fs::remove_dir(&directory).await.unwrap();
    }

    #[tokio::test]
    async fn corrupt_primary_recovers_from_last_good_backup() {
        let path = test_path("recovery");
        let first = AppState::with_persistence_path(Config::default(), &path);

        insert_sample(&first, "checkout-api", 100.0).await;
        first.persist_now().await.unwrap();
        insert_sample(&first, "checkout-api", 200.0).await;
        first.persist_now().await.unwrap();

        fs::write(&path, b"{ definitely-not-valid-json")
            .await
            .unwrap();

        let recovered = AppState::with_persistence_path(Config::default(), &path);
        let report = recovered.restore().await.unwrap();

        assert_eq!(report.source, RestoreSource::Backup);
        assert!(report.quarantined_file.is_some());
        assert_eq!(report.metric_samples, 1);

        let services = recovered.services.read().await;
        assert_eq!(
            services["checkout-api"]
                .metrics
                .back()
                .unwrap()
                .requests_per_second,
            100.0
        );
        drop(services);

        if let Some(quarantined) = report.quarantined_file {
            let _ = fs::remove_file(quarantined).await;
        }

        clean(&path).await;
    }

    #[tokio::test]
    async fn stale_service_history_is_removed() {
        let path = test_path("stale-cleanup");
        let mut state = AppState::with_persistence_path(Config::default(), &path);
        state.stale_service_ttl = Duration::from_secs(1);
        insert_sample(&state, "old-api", 10.0).await;

        {
            let mut services = state.services.write().await;
            let runtime = services.get_mut("old-api").unwrap();
            let old_timestamp = Utc::now() - chrono::Duration::minutes(5);
            runtime.metrics.back_mut().unwrap().timestamp = old_timestamp;
            runtime.decisions.back_mut().unwrap().timestamp = old_timestamp;
        }

        let report = state.cleanup_stale_services().await;

        assert_eq!(report.removed, vec!["old-api".to_string()]);
        assert!(state.services.read().await.is_empty());

        let health = state.persistence_health().await;
        assert_eq!(health.services_removed_total, 1);
        assert!(health.last_cleanup_at.is_some());

        clean(&path).await;
    }

    #[tokio::test]
    async fn fresh_service_history_is_retained() {
        let path = test_path("fresh-retention");
        let mut state = AppState::with_persistence_path(Config::default(), &path);
        state.stale_service_ttl = Duration::from_secs(1);
        insert_sample(&state, "active-api", 100.0).await;

        let report = state.cleanup_stale_services().await;

        assert!(report.removed.is_empty());
        assert!(state.services.read().await.contains_key("active-api"));

        clean(&path).await;
    }
}
