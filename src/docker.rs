use crate::{backend::BackendRegistry, config::DockerConfig, model::ExecutionReport};
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    sync::Arc,
};
use tokio::{
    process::Command,
    sync::{Mutex, RwLock},
    task::JoinHandle,
    time::{interval, sleep, Duration, Instant, MissedTickBehavior},
};
use tracing::{info, warn};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecoveryReport {
    pub services: usize,
    pub containers: usize,
    pub healthy_backends: usize,
    pub service_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SupervisionHealth {
    pub enabled: bool,
    pub interval_seconds: u64,
    pub unhealthy_threshold: u32,
    pub last_check_at: Option<DateTime<Utc>>,
    pub checks_total: u64,
    pub repair_attempts_total: u64,
    pub recovered_replicas_total: u64,
    pub last_error: Option<String>,
}

#[derive(Default)]
struct ReconcileQueue {
    pending: HashMap<String, u32>,
    running: HashSet<String>,
}

#[derive(Clone)]
pub struct DockerExecutor {
    config: DockerConfig,
    registry: BackendRegistry,
    client: reqwest::Client,
    docker_lock: Arc<Mutex<()>>,
    queue: Arc<Mutex<ReconcileQueue>>,
    targets: Arc<Mutex<HashMap<String, u32>>>,
    health_failures: Arc<Mutex<HashMap<String, u32>>>,
    supervision_health: Arc<RwLock<SupervisionHealth>>,
}

impl DockerExecutor {
    pub fn new(config: DockerConfig, registry: BackendRegistry) -> Self {
        let supervision_health = SupervisionHealth {
            enabled: config.enabled && config.supervision_enabled,
            interval_seconds: config.supervision_interval_seconds,
            unhealthy_threshold: config.unhealthy_threshold,
            last_check_at: None,
            checks_total: 0,
            repair_attempts_total: 0,
            recovered_replicas_total: 0,
            last_error: None,
        };

        Self {
            config,
            registry,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(2))
                .build()
                .expect("valid Docker health-check HTTP client"),
            docker_lock: Arc::new(Mutex::new(())),
            queue: Arc::new(Mutex::new(ReconcileQueue::default())),
            targets: Arc::new(Mutex::new(HashMap::new())),
            health_failures: Arc::new(Mutex::new(HashMap::new())),
            supervision_health: Arc::new(RwLock::new(supervision_health)),
        }
    }

    pub fn enabled(&self) -> bool {
        self.config.enabled
    }

    pub fn supervision_enabled(&self) -> bool {
        self.enabled() && self.config.supervision_enabled
    }

    pub async fn supervision_health(&self) -> SupervisionHealth {
        self.supervision_health.read().await.clone()
    }

    pub async fn set_target(&self, service: String, desired: u32) {
        if self.enabled() {
            self.targets.lock().await.insert(service, desired.max(1));
        }
    }

    /// Records the newest desired topology and starts at most one worker for a
    /// service. Bursty metric windows therefore update the target instead of
    /// creating an unbounded queue of stale Docker operations.
    pub async fn schedule(&self, service: String, desired: u32) {
        if !self.enabled() {
            return;
        }

        self.set_target(service.clone(), desired).await;

        let start_worker = {
            let mut queue = self.queue.lock().await;
            queue.pending.insert(service.clone(), desired);
            queue.running.insert(service.clone())
        };

        if start_worker {
            let executor = self.clone();

            tokio::spawn(async move {
                executor.run_worker(service).await;
            });
        }
    }

    async fn run_worker(&self, service: String) {
        loop {
            let desired = {
                let mut queue = self.queue.lock().await;

                match queue.pending.remove(&service) {
                    Some(desired) => desired,
                    None => {
                        queue.running.remove(&service);
                        return;
                    }
                }
            };

            let report = self.reconcile(&service, desired).await;

            if let Some(error) = report.error {
                if report.current_before > desired {
                    self.set_target(service.clone(), report.current_before)
                        .await;
                }

                warn!(
                    service = %service,
                    desired_replicas = desired,
                    error = %error,
                    "background Docker reconciliation failed"
                );
            } else if !report.started.is_empty() || !report.stopped.is_empty() {
                info!(
                    service = %service,
                    desired_replicas = desired,
                    started = report.started.len(),
                    stopped = report.stopped.len(),
                    "background Docker reconciliation completed"
                );
            }
        }
    }

    pub async fn reconcile(&self, service: &str, desired: u32) -> ExecutionReport {
        let _guard = self.docker_lock.lock().await;

        match self.reconcile_inner(service, desired).await {
            Ok(report) => report,
            Err(error) => {
                let containers = self.list(service).await.unwrap_or_default();
                self.refresh_registry(service, &containers).await;

                ExecutionReport {
                    current_before: containers.len() as u32,
                    desired,
                    started: vec![],
                    stopped: vec![],
                    backends: self.registry.snapshots(service).await,
                    error: Some(error),
                }
            }
        }
    }

    /// Rebuilds the in-memory proxy registry from running containers after a
    /// controller restart. Labels are authoritative and adoption is restricted
    /// to this controller's configured name prefix.
    pub async fn restore_registry(&self) -> Result<RecoveryReport, String> {
        if !self.enabled() {
            return Ok(RecoveryReport::default());
        }

        let _guard = self.docker_lock.lock().await;
        let discovered = self.list_managed().await;
        {
            let mut health = self.supervision_health.write().await;
            health.last_check_at = Some(Utc::now());
            health.last_error = discovered.as_ref().err().cloned();
        }
        let discovered = discovered?;
        let mut services: HashMap<String, Vec<String>> = HashMap::new();

        for (service, name) in discovered {
            services.entry(service).or_default().push(name);
        }

        let mut report = RecoveryReport {
            services: services.len(),
            containers: 0,
            healthy_backends: 0,
            service_names: services.keys().cloned().collect(),
        };

        report.service_names.sort();

        for (service, mut names) in services {
            names.sort_by_key(|name| replica_index(name).unwrap_or(0));
            report.containers += names.len();
            self.refresh_registry(&service, &names).await;
            report.healthy_backends += self.registry.healthy_count(&service).await as usize;
            self.targets
                .lock()
                .await
                .entry(service)
                .or_insert(names.len() as u32);
        }

        Ok(report)
    }

    pub fn spawn_supervision_task(&self) -> Option<JoinHandle<()>> {
        if !self.supervision_enabled() {
            return None;
        }

        let executor = self.clone();

        Some(tokio::spawn(async move {
            let mut ticker = interval(Duration::from_secs(
                executor.config.supervision_interval_seconds,
            ));
            ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
            ticker.tick().await;

            loop {
                ticker.tick().await;
                executor.supervise_once().await;
            }
        }))
    }

    async fn supervise_once(&self) {
        let targets = self.targets.lock().await.clone();
        let mut repairs = 0_u64;
        let mut recovered = 0_u64;
        let mut errors = Vec::new();
        if let Err(error) = self
            .command(vec![
                "info".into(),
                "--format".into(),
                "{{.ServerVersion}}".into(),
            ])
            .await
        {
            errors.push(error);
        }

        for (service, desired) in targets {
            match self.supervise_service(&service, desired).await {
                Ok(started) => {
                    if started > 0 {
                        repairs += 1;
                        recovered += started as u64;
                        info!(
                            service = %service,
                            desired_replicas = desired,
                            recovered_replicas = started,
                            "Docker topology supervisor repaired managed service"
                        );
                    }
                }
                Err(error) => {
                    warn!(
                        service = %service,
                        desired_replicas = desired,
                        error = %error,
                        "Docker topology supervision failed"
                    );
                    errors.push(format!("{service}: {error}"));
                }
            }
        }

        let mut health = self.supervision_health.write().await;
        health.last_check_at = Some(Utc::now());
        health.checks_total += 1;
        health.repair_attempts_total += repairs;
        health.recovered_replicas_total += recovered;
        health.last_error = if errors.is_empty() {
            None
        } else {
            Some(errors.join("; "))
        };
    }

    async fn supervise_service(&self, service: &str, desired: u32) -> Result<usize, String> {
        let _guard = self.docker_lock.lock().await;
        let mut containers = self.list(service).await?;
        self.refresh_registry(service, &containers).await;

        let snapshots = self.registry.snapshots(service).await;
        let mut confirmed_unhealthy = Vec::new();

        {
            let mut failures = self.health_failures.lock().await;

            for backend in snapshots {
                if backend.draining {
                    continue;
                }

                if record_health_observation(
                    &mut failures,
                    &backend.name,
                    backend.healthy,
                    self.config.unhealthy_threshold,
                ) {
                    confirmed_unhealthy.push(backend.name);
                }
            }
        }

        if !confirmed_unhealthy.is_empty() {
            self.registry
                .mark_draining(service, &confirmed_unhealthy)
                .await;

            let drain = self
                .registry
                .wait_drained(
                    service,
                    &confirmed_unhealthy,
                    Duration::from_secs(self.config.drain_timeout_seconds),
                )
                .await;

            if drain.drained {
                for name in &confirmed_unhealthy {
                    self.command(vec![
                        "stop".into(),
                        "--time".into(),
                        self.config.drain_timeout_seconds.to_string(),
                        name.clone(),
                    ])
                    .await?;
                }

                containers.retain(|name| !confirmed_unhealthy.contains(name));

                let mut failures = self.health_failures.lock().await;
                for name in &confirmed_unhealthy {
                    failures.remove(name);
                }
            } else {
                self.registry
                    .cancel_draining(service, &confirmed_unhealthy)
                    .await;
            }
        }

        if containers.len() as u32 >= desired {
            return Ok(0);
        }

        let report = self.reconcile_inner(service, desired).await?;
        Ok(report.started.len())
    }

    async fn reconcile_inner(
        &self,
        service: &str,
        desired: u32,
    ) -> Result<ExecutionReport, String> {
        let mut containers = self.list(service).await?;
        let current_before = containers.len() as u32;
        let mut started = Vec::new();
        let mut stopped = Vec::new();

        if current_before < desired {
            let used: BTreeSet<u32> = containers
                .iter()
                .filter_map(|name| replica_index(name))
                .collect();

            for index in (1..=desired)
                .filter(|index| !used.contains(index))
                .take((desired - current_before) as usize)
            {
                let name = self.start(service, index).await?;
                started.push(name.clone());
                containers.push(name);
            }
        } else if current_before > desired {
            containers.sort_by_key(|name| replica_index(name).unwrap_or(0));
            let remove_count = (current_before - desired) as usize;
            let draining: Vec<String> = containers
                .iter()
                .rev()
                .take(remove_count)
                .cloned()
                .collect();

            self.refresh_registry(service, &containers).await;
            self.registry.mark_draining(service, &draining).await;

            let status = self
                .registry
                .wait_drained(
                    service,
                    &draining,
                    Duration::from_secs(self.config.drain_timeout_seconds),
                )
                .await;

            if !status.drained {
                self.registry.cancel_draining(service, &draining).await;

                return Err(format!(
                    "safe scale-in cancelled after {} seconds; {} active request(s) still use draining replicas",
                    self.config.drain_timeout_seconds,
                    status.remaining_active_requests,
                ));
            }

            for name in &draining {
                self.command(vec![
                    "stop".into(),
                    "--time".into(),
                    self.config.drain_timeout_seconds.to_string(),
                    name.clone(),
                ])
                .await?;

                stopped.push(name.clone());
            }

            containers.retain(|name| !draining.contains(name));
        }

        containers.sort_by_key(|name| replica_index(name).unwrap_or(0));
        self.refresh_registry(service, &containers).await;

        Ok(ExecutionReport {
            current_before,
            desired,
            started,
            stopped,
            backends: self.registry.snapshots(service).await,
            error: None,
        })
    }

    async fn list(&self, service: &str) -> Result<Vec<String>, String> {
        let output = self
            .command(vec![
                "ps".into(),
                "--filter".into(),
                "label=fluxscale.managed=true".into(),
                "--filter".into(),
                format!("label=fluxscale.service={service}"),
                "--filter".into(),
                format!("name={}-", self.config.name_prefix),
                "--format".into(),
                "{{.Names}}".into(),
            ])
            .await?;

        let expected_prefix = format!("{}-", self.config.name_prefix);

        Ok(output
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && line.starts_with(&expected_prefix))
            .map(str::to_string)
            .collect())
    }

    async fn list_managed(&self) -> Result<Vec<(String, String)>, String> {
        let output = self
            .command(vec![
                "ps".into(),
                "--filter".into(),
                "label=fluxscale.managed=true".into(),
                "--filter".into(),
                format!("name={}-", self.config.name_prefix),
                "--format".into(),
                "{{.Names}}\t{{.Label \"fluxscale.service\"}}".into(),
            ])
            .await?;

        parse_managed_containers(&output, &self.config.name_prefix)
    }

    async fn start(&self, service: &str, index: u32) -> Result<String, String> {
        let safe_service = sanitize(service);
        let name = format!("{}-{}-{}", self.config.name_prefix, safe_service, index);

        let mut args = vec![
            "run".into(),
            "-d".into(),
            "--rm".into(),
            "--name".into(),
            name.clone(),
            "--label".into(),
            "fluxscale.managed=true".into(),
            "--label".into(),
            format!("fluxscale.service={service}"),
            "-e".into(),
            format!("INSTANCE_ID={name}"),
        ];
        if let Some(network) = &self.config.network {
            args.extend(["--network".into(), network.clone()]);
        } else {
            let port = self.port(service, index)?;
            args.extend([
                "-p".into(),
                format!("127.0.0.1:{port}:{}", self.config.container_port),
            ]);
        }
        for (key, value) in [
            ("FLUXSCALE_SERVICE", service.to_string()),
            ("FLUXSCALE_INSTANCE_ID", name.clone()),
            ("PORT", self.config.container_port.to_string()),
        ] {
            args.extend(["-e".into(), format!("{key}={value}")]);
        }
        if let Some(endpoint) = &self.config.telemetry_endpoint {
            args.extend(["-e".into(), format!("FLUXSCALE_ENDPOINT={endpoint}")]);
        }
        for name in &self.config.environment {
            if std::env::var_os(name).is_none() {
                return Err(format!(
                    "required container environment variable {name} is missing"
                ));
            }
            // Pass names only; Docker reads values from its inherited environment.
            args.extend(["-e".into(), name.clone()]);
        }
        if let Some(cpus) = self.config.cpus {
            args.extend(["--cpus".into(), cpus.to_string()]);
        }
        if let Some(memory) = self.config.memory_mb {
            args.extend(["--memory".into(), format!("{memory}m")]);
        }
        args.push(self.config.image.clone());
        self.command(args).await?;

        let url = self.backend_url(service, &name)?;
        self.wait_healthy(&url).await?;

        Ok(name)
    }

    async fn refresh_registry(&self, service: &str, names: &[String]) {
        let mut entries = Vec::new();

        for name in names {
            let Ok(url) = self.backend_url(service, name) else {
                continue;
            };
            let healthy = self
                .client
                .get(format!("{url}/health"))
                .send()
                .await
                .map(|response| response.status().is_success())
                .unwrap_or(false);

            entries.push((name.clone(), url, healthy));
        }

        self.registry.replace_service(service, entries).await;
    }

    async fn wait_healthy(&self, url: &str) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(self.config.health_timeout_seconds);

        while Instant::now() < deadline {
            if self
                .client
                .get(format!("{url}/health"))
                .send()
                .await
                .map(|response| response.status().is_success())
                .unwrap_or(false)
            {
                return Ok(());
            }

            sleep(Duration::from_millis(250)).await;
        }

        Err(format!("container at {url} did not become healthy"))
    }

    fn backend_url(&self, service: &str, name: &str) -> Result<String, String> {
        if self.config.network.is_some() {
            Ok(format!("http://{name}:{}", self.config.container_port))
        } else {
            let index = replica_index(name).ok_or("invalid replica name")?;
            Ok(format!("http://127.0.0.1:{}", self.port(service, index)?))
        }
    }

    fn port(&self, service: &str, index: u32) -> Result<u16, String> {
        let block = stable_hash(service) % 1000;
        let port =
            self.config.host_port_base as u32 + block * self.config.port_block_size as u32 + index;

        u16::try_from(port).map_err(|_| format!("calculated port {port} is invalid"))
    }

    async fn command(&self, args: Vec<String>) -> Result<String, String> {
        let output = Command::new("docker")
            .args(&args)
            .output()
            .await
            .map_err(|error| format!("failed to run docker: {error}"))?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }
}

fn parse_managed_containers(
    output: &str,
    name_prefix: &str,
) -> Result<Vec<(String, String)>, String> {
    let expected_prefix = format!("{name_prefix}-");
    let mut records = Vec::new();

    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Some((name, service)) = line.split_once('\t') else {
            return Err(format!("invalid Docker discovery record: {line}"));
        };

        let name = name.trim();
        let service = service.trim();

        if name.is_empty() || service.is_empty() || !name.starts_with(&expected_prefix) {
            return Err(format!("invalid Docker discovery record: {line}"));
        }

        records.push((service.to_string(), name.to_string()));
    }

    Ok(records)
}

fn sanitize(service: &str) -> String {
    service
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect()
}

fn replica_index(name: &str) -> Option<u32> {
    name.rsplit('-').next()?.parse().ok()
}

fn stable_hash(value: &str) -> u32 {
    value.bytes().fold(2_166_136_261_u32, |hash, byte| {
        (hash ^ byte as u32).wrapping_mul(16_777_619)
    })
}

fn record_health_observation(
    failures: &mut HashMap<String, u32>,
    backend: &str,
    healthy: bool,
    threshold: u32,
) -> bool {
    if healthy {
        failures.remove(backend);
        return false;
    }

    let count = failures.entry(backend.to_string()).or_default();
    *count = count.saturating_add(1);
    *count >= threshold
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_names_are_safe_for_docker() {
        assert_eq!(sanitize("Payment API/v2"), "payment-api-v2");
    }

    #[test]
    fn network_backends_use_container_dns_and_default_backends_use_loopback() {
        let mut config = DockerConfig::default();
        config.network = Some("fluxscale-app".into());
        let executor = DockerExecutor::new(config.clone(), BackendRegistry::default());
        assert_eq!(
            executor
                .backend_url("orders", "fluxscale-orders-1")
                .unwrap(),
            "http://fluxscale-orders-1:3000"
        );
        config.network = None;
        let executor = DockerExecutor::new(config, BackendRegistry::default());
        assert_eq!(
            executor
                .backend_url("orders", "fluxscale-orders-1")
                .unwrap(),
            format!("http://127.0.0.1:{}", executor.port("orders", 1).unwrap())
        );
    }

    #[test]
    fn replica_suffix_is_parsed() {
        assert_eq!(replica_index("fluxscale-payment-api-12"), Some(12));
    }

    #[test]
    fn restart_discovery_parses_service_labels() {
        let parsed = parse_managed_containers(
            "fluxscale-orders-1\torders\nfluxscale-orders-2\torders\n",
            "fluxscale",
        )
        .unwrap();

        assert_eq!(
            parsed,
            vec![
                ("orders".to_string(), "fluxscale-orders-1".to_string()),
                ("orders".to_string(), "fluxscale-orders-2".to_string()),
            ]
        );
    }

    #[test]
    fn restart_discovery_rejects_foreign_prefixes() {
        assert!(parse_managed_containers("other-orders-1\torders", "fluxscale").is_err());
    }

    #[test]
    fn unhealthy_backend_requires_consecutive_failures() {
        let mut failures = HashMap::new();

        assert!(!record_health_observation(
            &mut failures,
            "replica-1",
            false,
            3,
        ));
        assert!(!record_health_observation(
            &mut failures,
            "replica-1",
            false,
            3,
        ));
        assert!(record_health_observation(
            &mut failures,
            "replica-1",
            false,
            3,
        ));
    }

    #[test]
    fn healthy_observation_resets_failure_streak() {
        let mut failures = HashMap::new();

        assert!(!record_health_observation(
            &mut failures,
            "replica-1",
            false,
            2,
        ));
        assert!(!record_health_observation(
            &mut failures,
            "replica-1",
            true,
            2,
        ));
        assert!(!record_health_observation(
            &mut failures,
            "replica-1",
            false,
            2,
        ));
    }
}
