//! Prometheus exposition and readiness classification for the FluxScale controller.
//!
//! Cardinality: the only dynamic label is `service` (per monitored service). All
//! other labels enumerate a small, fixed set of values (`action`, `phase`,
//! `status`, `state`, `probe`). No per-request, per-instance, per-path or
//! per-credential labels are emitted. Audit-buffer counts and persistence
//! health are gauges, not cumulative counters, so the bounded buffer does not
//! masquerade as a monotonic counter that pretends to know a system lifetime
//! total. Capacity safe/saturation gauges are only emitted when saturation has
//! been observed so an unknown capacity is not represented as zero.

use std::fmt::Write as _;
use std::sync::OnceLock;
use std::time::Instant;

use axum::{
    extract::State,
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde_json::json;

use crate::{
    capacity::{estimate_capacity, CapacityPhase},
    docker::SupervisionHealth,
    model::{BackendSnapshot, MetricSample, ScalingAction},
    operations::{OperationsSnapshot, OperationsState},
    state::{AppState, PersistenceHealth, ServiceRuntime},
};

pub const PROMETHEUS_CONTENT_TYPE: &str = "text/plain; version=0.0.4; charset=utf-8";
pub const READINESS_PATH: &str = "/api/v1/observability/ready";
pub const METRICS_PATH: &str = "/api/v1/observability/metrics";

const SCALE_UP: &str = "scale_up";
const SCALE_DOWN: &str = "scale_down";
const HOLD: &str = "hold";
const PHASE_WARMING_UP: &str = "warming_up";
const PHASE_LEARNING: &str = "learning";
const PHASE_SATURATION_OBSERVED: &str = "saturation_observed";
const PROBE_OK: &str = "ok";
const PROBE_DEGRADED: &str = "degraded";
const PERSISTENCE_HEALTHY: &str = "healthy";
const PERSISTENCE_DEGRADED: &str = "degraded";
const STATE_ENABLED: &str = "enabled";
const STATE_DISABLED: &str = "disabled";
const SUPERVISION_UNHEALTHY: &str = "unhealthy";

static PROCESS_START: OnceLock<Instant> = OnceLock::new();

pub fn mark_started() {
    PROCESS_START.get_or_init(Instant::now);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadinessProbe {
    Ok,
    Degraded,
}

impl ReadinessProbe {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => PROBE_OK,
            Self::Degraded => PROBE_DEGRADED,
        }
    }
}

pub async fn metrics_handler(
    State(state): State<AppState>,
    Extension(operations): Extension<OperationsState>,
) -> Response {
    let body = render_metrics(&state, &operations).await;
    let mut response = (StatusCode::OK, body).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(PROMETHEUS_CONTENT_TYPE),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    response
}

pub async fn readiness_handler(State(state): State<AppState>) -> Response {
    let probe = classify_readiness(&state).await;
    let (status, body) = match probe {
        ReadinessProbe::Ok => (StatusCode::OK, json!({"status": "ok", "probe": "ok"})),
        ReadinessProbe::Degraded => (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"status": "not_ready", "probe": "degraded"}),
        ),
    };
    (status, Json(body)).into_response()
}

pub async fn classify_readiness(state: &AppState) -> ReadinessProbe {
    let persistence = state.persistence_health().await;
    let supervision = state.docker.supervision_health().await;
    classify_health(&persistence, &supervision)
}

pub fn classify_health(
    persistence: &PersistenceHealth,
    supervision: &SupervisionHealth,
) -> ReadinessProbe {
    if persistence.last_successful_save_at.is_none() || persistence.last_save_error.is_some() {
        return ReadinessProbe::Degraded;
    }
    if supervision.last_error.is_some()
        || (supervision.enabled && supervision.last_check_at.is_none())
    {
        return ReadinessProbe::Degraded;
    }
    ReadinessProbe::Ok
}

pub async fn render_metrics(state: &AppState, operations: &OperationsState) -> String {
    let snapshot = operations.snapshot().await;
    let persistence = state.persistence_health().await;
    let supervision = state.docker.supervision_health().await;
    let cutoff =
        Utc::now() - ChronoDuration::seconds(state.config.ingestion.instance_stale_after_seconds);

    let services: Vec<(String, ServiceRuntime)> = {
        let guard = state.services.read().await;
        guard
            .iter()
            .map(|(name, runtime)| (name.clone(), runtime.clone()))
            .collect()
    };

    let mut out = String::with_capacity(4096);
    write_family_declarations(&mut out);
    write_build_info(&mut out);
    write_uptime(&mut out);
    write_readiness(&mut out, classify_health(&persistence, &supervision));
    write_persistence(&mut out, &persistence);
    write_docker(&mut out, &supervision, state.config.docker.enabled);
    write_audit(&mut out, &snapshot);

    let _ = writeln!(out, "fluxscale_services {}", services.len());

    for (name, runtime) in &services {
        let backends = state.registry.snapshots(name).await;
        let fresh = count_fresh(runtime, cutoff);
        let stale = runtime.instances.len().saturating_sub(fresh);
        write_service(&mut out, name, runtime, &backends, fresh, stale, cutoff);
    }

    // Prometheus text requires each family's metadata and samples together.
    let mut lines: Vec<_> = out.lines().collect();
    lines.sort_by_key(|line| {
        line.strip_prefix("# HELP ")
            .or_else(|| line.strip_prefix("# TYPE "))
            .unwrap_or(line)
            .split(['{', ' '])
            .next()
            .unwrap_or("")
    });
    format!("{}\n", lines.join("\n"))
}

fn write_family_declarations(out: &mut String) {
    let families = [
        (
            "fluxscale_build_info",
            "FluxScale controller build information.",
        ),
        (
            "fluxscale_controller_uptime_seconds",
            "Process uptime in seconds since the controller bound its API.",
        ),
        (
            "fluxscale_readiness",
            "Current readiness probe (1 == current probe state).",
        ),
        (
            "fluxscale_persistence_status",
            "Persistence health (1 == current status).",
        ),
        (
            "fluxscale_persistence_state_schema_version",
            "Schema version of the persisted state file.",
        ),
        (
            "fluxscale_persistence_last_save_age_seconds",
            "Seconds since the most recent successful checkpoint (omitted before the first successful save).",
        ),
        (
            "fluxscale_docker_enabled",
            "Whether the Docker executor is enabled (1 == current state).",
        ),
        (
            "fluxscale_docker_supervision_status",
            "Continuous supervision state (1 == current state).",
        ),
        (
            "fluxscale_audit_events",
            "Current number of audit events held in the bounded buffer.",
        ),
        (
            "fluxscale_audit_capacity",
            "Configured maximum length of the bounded audit buffer.",
        ),
        (
            "fluxscale_audit_rate_limited_events",
            "Audit events currently held in the buffer that were rate limited.",
        ),
        (
            "fluxscale_services",
            "Monitored services currently known to the controller.",
        ),
        (
            "fluxscale_service_known",
            "Whether the controller has observed telemetry for the service (1 == observed).",
        ),
        (
            "fluxscale_service_telemetry_fresh",
            "Whether current telemetry is available (stale traffic gauges are omitted).",
        ),
        (
            "fluxscale_service_current_replicas",
            "Replica count reported by the most recent ingest sample.",
        ),
        (
            "fluxscale_service_desired_replicas",
            "Replica target of the most recent scaling decision.",
        ),
        (
            "fluxscale_service_requests_per_second",
            "Requests per second from the most recent ingest sample.",
        ),
        (
            "fluxscale_service_predicted_rps",
            "Predicted requests per second at the configured horizon.",
        ),
        (
            "fluxscale_service_active_requests",
            "Active in-flight requests from the most recent ingest sample.",
        ),
        (
            "fluxscale_service_p95_latency_seconds",
            "Maximum fresh instance P95 latency in seconds; not a fleet quantile.",
        ),
        (
            "fluxscale_service_error_rate",
            "Error ratio from the most recent ingest sample.",
        ),
        (
            "fluxscale_service_decision_action",
            "Most recent scaling-decision action (1 == current action).",
        ),
        (
            "fluxscale_service_fresh_instances",
            "Instances whose latest sample is still fresh.",
        ),
        (
            "fluxscale_service_stale_instances",
            "Instances whose latest sample is stale.",
        ),
        (
            "fluxscale_service_backends",
            "Backends currently registered for the service.",
        ),
        (
            "fluxscale_service_backends_healthy",
            "Backends currently registered and healthy for the service.",
        ),
        (
            "fluxscale_service_capacity_phase",
            "Capacity learning phase for the service (1 == current phase).",
        ),
        (
            "fluxscale_service_capacity_known",
            "1 if a calibrated safe RPS per replica is known for the service.",
        ),
        (
            "fluxscale_service_capacity_confidence",
            "Capacity learning confidence in [0, 1].",
        ),
        (
            "fluxscale_service_capacity_safe_rps",
            "Calibrated safe RPS per replica; only emitted when calibration has completed.",
        ),
        (
            "fluxscale_service_capacity_saturation_rps",
            "Observed saturation RPS per replica; only emitted when calibration has completed.",
        ),
    ];

    for (name, description) in families {
        let _ = writeln!(out, "# HELP {name} {description}");
        let _ = writeln!(out, "# TYPE {name} gauge");
    }
}

fn write_build_info(out: &mut String) {
    let version = env!("CARGO_PKG_VERSION");
    let _ = writeln!(
        out,
        "fluxscale_build_info{{version=\"{}\",release=\"8A\"}} 1",
        escape_label_value(version),
    );
}

fn write_uptime(out: &mut String) {
    let start = PROCESS_START.get_or_init(Instant::now);
    let seconds = Instant::now().duration_since(*start).as_secs_f64();
    let _ = writeln!(out, "fluxscale_controller_uptime_seconds {seconds:.3}");
}

fn write_readiness(out: &mut String, probe: ReadinessProbe) {
    for label in [PROBE_OK, PROBE_DEGRADED] {
        let value = i32::from(probe.as_str() == label);
        let _ = writeln!(out, "fluxscale_readiness{{probe=\"{label}\"}} {value}",);
    }
}

fn write_persistence(out: &mut String, persistence: &PersistenceHealth) {
    let current =
        if persistence.last_successful_save_at.is_none() || persistence.last_save_error.is_some() {
            PERSISTENCE_DEGRADED
        } else {
            PERSISTENCE_HEALTHY
        };
    for label in [PERSISTENCE_HEALTHY, PERSISTENCE_DEGRADED] {
        let value = i32::from(label == current);
        let _ = writeln!(
            out,
            "fluxscale_persistence_status{{status=\"{label}\"}} {value}",
        );
    }

    let _ = writeln!(
        out,
        "fluxscale_persistence_state_schema_version {}",
        persistence.state_schema_version
    );

    if let Some(saved_at) = persistence.last_successful_save_at {
        let age = (Utc::now() - saved_at).num_milliseconds() as f64 / 1_000.0;
        if age.is_finite() && age >= 0.0 {
            let _ = writeln!(out, "fluxscale_persistence_last_save_age_seconds {age:.3}");
        }
    }
}

fn write_docker(out: &mut String, supervision: &SupervisionHealth, docker_enabled: bool) {
    let current = if docker_enabled {
        STATE_ENABLED
    } else {
        STATE_DISABLED
    };
    for label in [STATE_ENABLED, STATE_DISABLED] {
        let value = i32::from(label == current);
        let _ = writeln!(out, "fluxscale_docker_enabled{{state=\"{label}\"}} {value}");
    }

    let current = if !docker_enabled {
        STATE_DISABLED
    } else if supervision.last_error.is_some() {
        SUPERVISION_UNHEALTHY
    } else if supervision.enabled {
        STATE_ENABLED
    } else {
        STATE_DISABLED
    };
    for label in [STATE_DISABLED, STATE_ENABLED, SUPERVISION_UNHEALTHY] {
        let value = i32::from(label == current);
        let _ = writeln!(
            out,
            "fluxscale_docker_supervision_status{{status=\"{label}\"}} {value}"
        );
    }
}

fn write_audit(out: &mut String, snapshot: &OperationsSnapshot) {
    let rate_limited = snapshot
        .events
        .iter()
        .filter(|event| event.rate_limited)
        .count();
    let _ = writeln!(out, "fluxscale_audit_events {}", snapshot.events.len());
    let _ = writeln!(out, "fluxscale_audit_capacity {}", snapshot.audit_capacity);
    let _ = writeln!(out, "fluxscale_audit_rate_limited_events {rate_limited}");
}

fn count_fresh(runtime: &ServiceRuntime, cutoff: DateTime<Utc>) -> usize {
    runtime
        .instances
        .values()
        .filter(|instance| instance.sample.timestamp >= cutoff)
        .count()
}

fn write_service(
    out: &mut String,
    name: &str,
    runtime: &ServiceRuntime,
    backends: &[BackendSnapshot],
    fresh_count: usize,
    stale_count: usize,
    cutoff: DateTime<Utc>,
) {
    let label = escape_label_value(name);

    let Some(latest) = runtime.metrics.back() else {
        let _ = writeln!(out, "fluxscale_service_known{{service=\"{label}\"}} 0");
        return;
    };

    let _ = writeln!(out, "fluxscale_service_known{{service=\"{label}\"}} 1");
    let current = if runtime.instances.is_empty() {
        (latest.timestamp >= cutoff).then(|| latest.clone())
    } else if fresh_count > 0 {
        Some(crate::api::aggregate_instance_metrics(
            runtime
                .instances
                .values()
                .map(|instance| &instance.sample)
                .filter(|sample| sample.timestamp >= cutoff),
            Utc::now(),
        ))
    } else {
        None
    };
    let _ = writeln!(
        out,
        "fluxscale_service_telemetry_fresh{{service=\"{label}\"}} {}",
        i32::from(current.is_some())
    );
    let _ = writeln!(
        out,
        "fluxscale_service_current_replicas{{service=\"{label}\"}} {}",
        latest.current_replicas
    );
    if let Some(latest) = &current {
        let _ = writeln!(
            out,
            "fluxscale_service_requests_per_second{{service=\"{label}\"}} {:.3}",
            latest.requests_per_second
        );
        let _ = writeln!(
            out,
            "fluxscale_service_active_requests{{service=\"{label}\"}} {}",
            latest.active_requests
        );
        let _ = writeln!(
            out,
            "fluxscale_service_p95_latency_seconds{{service=\"{label}\"}} {:.3}",
            latest.p95_latency_ms / 1000.0
        );
        let _ = writeln!(
            out,
            "fluxscale_service_error_rate{{service=\"{label}\"}} {:.6}",
            latest.error_rate
        );
    }

    if let Some(decision) = runtime.decisions.back() {
        if current.is_some() {
            let _ = writeln!(
                out,
                "fluxscale_service_predicted_rps{{service=\"{label}\"}} {:.3}",
                decision.predicted_rps
            );
        }
        let _ = writeln!(
            out,
            "fluxscale_service_desired_replicas{{service=\"{label}\"}} {}",
            decision.desired_replicas
        );
        for label_action in [SCALE_UP, SCALE_DOWN, HOLD] {
            let matches = match (&decision.action, label_action) {
                (ScalingAction::ScaleUp, SCALE_UP) => true,
                (ScalingAction::ScaleDown, SCALE_DOWN) => true,
                (ScalingAction::Hold, HOLD) => true,
                _ => false,
            };
            let _ = writeln!(
                out,
                "fluxscale_service_decision_action{{service=\"{label}\",action=\"{label_action}\"}} {}",
                i32::from(matches),
            );
        }
    }

    let _ = writeln!(
        out,
        "fluxscale_service_fresh_instances{{service=\"{label}\"}} {fresh_count}"
    );
    let _ = writeln!(
        out,
        "fluxscale_service_stale_instances{{service=\"{label}\"}} {stale_count}"
    );

    let healthy_count = backends.iter().filter(|backend| backend.healthy).count();
    let _ = writeln!(
        out,
        "fluxscale_service_backends{{service=\"{label}\"}} {}",
        backends.len()
    );
    let _ = writeln!(
        out,
        "fluxscale_service_backends_healthy{{service=\"{label}\"}} {healthy_count}"
    );

    let history: Vec<MetricSample> = runtime.metrics.iter().cloned().collect();
    let estimate = estimate_capacity(&history);
    let phase_label = match estimate.phase {
        CapacityPhase::WarmingUp => PHASE_WARMING_UP,
        CapacityPhase::Learning => PHASE_LEARNING,
        CapacityPhase::SaturationObserved => PHASE_SATURATION_OBSERVED,
    };
    for label_phase in [PHASE_WARMING_UP, PHASE_LEARNING, PHASE_SATURATION_OBSERVED] {
        let _ = writeln!(
            out,
            "fluxscale_service_capacity_phase{{service=\"{label}\",phase=\"{label_phase}\"}} {}",
            i32::from(label_phase == phase_label),
        );
    }

    let capacity_known = estimate.phase == CapacityPhase::SaturationObserved;
    let _ = writeln!(
        out,
        "fluxscale_service_capacity_known{{service=\"{label}\"}} {}",
        i32::from(capacity_known),
    );
    let _ = writeln!(
        out,
        "fluxscale_service_capacity_confidence{{service=\"{label}\"}} {:.6}",
        estimate.confidence
    );

    if estimate.phase == CapacityPhase::SaturationObserved {
        if let Some(safe) = estimate.safe_rps_per_replica {
            let _ = writeln!(
                out,
                "fluxscale_service_capacity_safe_rps{{service=\"{label}\"}} {safe:.3}"
            );
        }
        if let Some(saturation) = estimate.saturation_rps_per_replica {
            let _ = writeln!(
                out,
                "fluxscale_service_capacity_saturation_rps{{service=\"{label}\"}} {saturation:.3}"
            );
        }
    }
}

fn escape_label_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::Config,
        docker::SupervisionHealth,
        model::{ScalingAction, ScalingDecision},
        operations::OperationsState,
        state::{AppState, InstanceRuntime, PersistenceHealth, RestoreSource},
    };
    use chrono::{Duration, TimeZone, Utc};
    use uuid::Uuid;

    fn empty_state() -> AppState {
        let mut config = Config::default();
        config.ingestion.instance_stale_after_seconds = 10;
        AppState::with_persistence_path(
            config,
            std::path::PathBuf::from("/tmp/fluxscale-observability-test.json"),
        )
    }

    fn sample(timestamp: DateTime<Utc>, rps: f64, current_replicas: u32) -> MetricSample {
        MetricSample {
            timestamp,
            requests_per_second: rps,
            active_requests: 1,
            p95_latency_ms: 50.0,
            error_rate: 0.0,
            cpu_percent: 20.0,
            memory_percent: 30.0,
            current_replicas,
        }
    }

    fn decision(timestamp: DateTime<Utc>) -> ScalingDecision {
        ScalingDecision {
            id: Uuid::new_v4(),
            service: "test".into(),
            timestamp,
            action: ScalingAction::Hold,
            current_replicas: 1,
            desired_replicas: 1,
            current_rps: 100.0,
            predicted_rps: 100.0,
            prediction_horizon_seconds: 10,
            reasons: vec!["test".into()],
        }
    }

    #[tokio::test]
    async fn empty_controller_still_emits_expected_families() {
        let state = empty_state();
        let ops = OperationsState::new(state.config.operations.clone());
        let body = render_metrics(&state, &ops).await;

        for family in [
            "fluxscale_build_info",
            "fluxscale_controller_uptime_seconds",
            "fluxscale_readiness",
            "fluxscale_persistence_status",
            "fluxscale_persistence_state_schema_version",
            "fluxscale_docker_enabled",
            "fluxscale_docker_supervision_status",
            "fluxscale_audit_events",
            "fluxscale_audit_capacity",
            "fluxscale_audit_rate_limited_events",
            "fluxscale_services",
        ] {
            assert!(
                body.contains(&format!("# TYPE {family} gauge")),
                "missing # TYPE for {family}: {body}"
            );
        }

        assert!(body.contains("fluxscale_services 0"));
        assert!(
            body.contains("fluxscale_build_info{version=\""),
            "missing build info sample line"
        );
        assert!(
            body.contains("fluxscale_readiness{probe=\"degraded\"} 1"),
            "an uninitialized controller must be unready: {body}"
        );
    }

    #[tokio::test]
    async fn release_is_exposed_as_8a() {
        let state = empty_state();
        let ops = OperationsState::new(state.config.operations.clone());
        let body = render_metrics(&state, &ops).await;

        assert!(
            body.contains(&format!(
                "fluxscale_build_info{{version=\"{}\",release=\"8A\"}} 1",
                env!("CARGO_PKG_VERSION")
            )),
            "expected 8A release in build_info: {body}"
        );
    }

    #[test]
    fn escapes_label_characters() {
        let escaped = escape_label_value("name \"with\" \\backslash\nnewline");
        assert_eq!(escaped, "name \\\"with\\\" \\\\backslash\\nnewline");
    }

    #[tokio::test]
    async fn unknown_capacity_does_not_emit_a_zero_safe_rps() {
        let state = empty_state();
        let ops = OperationsState::new(state.config.operations.clone());
        let base = Utc.timestamp_opt(1_700_000_000, 0).unwrap();
        let metrics: Vec<MetricSample> = (0..5)
            .map(|i| sample(base + Duration::seconds(i), 50.0, 1))
            .collect();

        {
            let mut guard = state.services.write().await;
            let runtime = guard.entry("svc".to_string()).or_default();
            for metric in &metrics {
                runtime.metrics.push_back(metric.clone());
            }
            runtime.decisions.push_back(decision(base));
        }

        let body = render_metrics(&state, &ops).await;
        assert!(
            body.contains("fluxscale_service_capacity_known{service=\"svc\"} 0"),
            "expected capacity_known=0 for uncalibrated service; body:\n{body}"
        );
        assert!(
            !body.contains("fluxscale_service_capacity_safe_rps{service=\"svc\"}"),
            "safe_rps must not be emitted while calibration is unknown: {body}"
        );
        assert!(
            !body.contains("fluxscale_service_capacity_saturation_rps{service=\"svc\"}"),
            "saturation_rps must not be emitted while calibration is unknown: {body}"
        );
    }

    #[tokio::test]
    async fn counts_fresh_and_stale_instances() {
        let state = empty_state();
        let ops = OperationsState::new(state.config.operations.clone());
        let now = Utc::now();
        let fresh_sample = sample(now - Duration::seconds(1), 100.0, 1);
        let stale_sample = sample(now - Duration::seconds(60), 50.0, 1);

        let mut guard = state.services.write().await;
        let runtime = guard.entry("svc".to_string()).or_default();
        runtime.metrics.push_back(fresh_sample.clone());
        runtime.metrics.push_back(stale_sample.clone());
        runtime.instances.insert(
            "fresh".into(),
            InstanceRuntime {
                workloads: vec![],
                sample: fresh_sample,
                decision: decision(now),
            },
        );
        runtime.instances.insert(
            "stale".into(),
            InstanceRuntime {
                workloads: vec![],
                sample: stale_sample,
                decision: decision(now),
            },
        );
        drop(guard);

        let body = render_metrics(&state, &ops).await;
        assert!(
            body.contains("fluxscale_service_fresh_instances{service=\"svc\"} 1"),
            "expected 1 fresh instance: {body}"
        );
        assert!(
            body.contains("fluxscale_service_stale_instances{service=\"svc\"} 1"),
            "expected 1 stale instance: {body}"
        );
    }

    #[test]
    fn readiness_is_ok_with_clean_inputs() {
        let mut persistence = PersistenceHealth {
            state_schema_version: 1,
            restore_source: RestoreSource::Empty,
            restored_at: None,
            restored_services: 0,
            restored_metric_samples: 0,
            restored_decisions: 0,
            last_successful_save_at: None,
            last_save_error: None,
            last_cleanup_at: None,
            services_removed_total: 0,
            stale_service_ttl_seconds: 86_400,
            maintenance_interval_seconds: 60,
        };
        let mut supervision = SupervisionHealth {
            enabled: false,
            interval_seconds: 5,
            unhealthy_threshold: 3,
            last_check_at: None,
            checks_total: 0,
            repair_attempts_total: 0,
            recovered_replicas_total: 0,
            last_error: None,
        };
        assert_eq!(
            classify_health(&persistence, &supervision),
            ReadinessProbe::Degraded
        );
        persistence.last_successful_save_at = Some(Utc::now() - Duration::days(1));
        assert_eq!(
            classify_health(&persistence, &supervision),
            ReadinessProbe::Ok
        );
        supervision.enabled = true;
        assert_eq!(
            classify_health(&persistence, &supervision),
            ReadinessProbe::Degraded
        );
        supervision.last_check_at = Some(Utc::now());
        assert_eq!(
            classify_health(&persistence, &supervision),
            ReadinessProbe::Ok
        );
        supervision.last_error = Some("Docker unavailable".into());
        assert_eq!(
            classify_health(&persistence, &supervision),
            ReadinessProbe::Degraded
        );
        supervision.last_error = None;
        assert_eq!(
            classify_health(&persistence, &supervision),
            ReadinessProbe::Ok
        );
    }

    #[test]
    fn readiness_is_degraded_when_persistence_save_error_exists() {
        let mut persistence = PersistenceHealth {
            state_schema_version: 1,
            restore_source: RestoreSource::Empty,
            restored_at: None,
            restored_services: 0,
            restored_metric_samples: 0,
            restored_decisions: 0,
            last_successful_save_at: None,
            last_save_error: None,
            last_cleanup_at: None,
            services_removed_total: 0,
            stale_service_ttl_seconds: 86_400,
            maintenance_interval_seconds: 60,
        };
        persistence.last_save_error = Some("disk full".into());
        let supervision = SupervisionHealth {
            enabled: false,
            interval_seconds: 5,
            unhealthy_threshold: 3,
            last_check_at: None,
            checks_total: 0,
            repair_attempts_total: 0,
            recovered_replicas_total: 0,
            last_error: None,
        };
        assert_eq!(
            classify_health(&persistence, &supervision),
            ReadinessProbe::Degraded
        );
    }

    #[test]
    fn readiness_is_degraded_when_supervisor_reports_error() {
        let persistence = PersistenceHealth {
            state_schema_version: 1,
            restore_source: RestoreSource::Empty,
            restored_at: None,
            restored_services: 0,
            restored_metric_samples: 0,
            restored_decisions: 0,
            last_successful_save_at: Some(Utc::now()),
            last_save_error: None,
            last_cleanup_at: None,
            services_removed_total: 0,
            stale_service_ttl_seconds: 86_400,
            maintenance_interval_seconds: 60,
        };
        let supervision = SupervisionHealth {
            enabled: true,
            interval_seconds: 5,
            unhealthy_threshold: 3,
            last_check_at: None,
            checks_total: 1,
            repair_attempts_total: 0,
            recovered_replicas_total: 0,
            last_error: Some("docker not reachable".into()),
        };
        assert_eq!(
            classify_health(&persistence, &supervision),
            ReadinessProbe::Degraded
        );
    }

    #[tokio::test]
    async fn metrics_handlers_use_prometheus_content_type_and_no_store() {
        let state = empty_state();
        let operations = OperationsState::new(state.config.operations.clone());
        let response = metrics_handler(State(state), Extension(operations)).await;
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            PROMETHEUS_CONTENT_TYPE
        );
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(response.headers()[header::PRAGMA], "no-cache");
    }

    #[tokio::test]
    async fn readiness_http_status_requires_a_successful_checkpoint() {
        let path = std::env::temp_dir().join(format!("fluxscale-ready-{}.json", Uuid::new_v4()));
        let state = AppState::with_persistence_path(Config::default(), &path);
        assert_eq!(
            readiness_handler(State(state.clone())).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        state.persist_now().await.unwrap();
        assert_eq!(
            readiness_handler(State(state)).await.status(),
            StatusCode::OK
        );
        tokio::fs::remove_file(path).await.unwrap();
    }

    #[tokio::test]
    async fn exporter_omits_expired_traffic_and_reaggregates_fresh_instances() {
        let state = empty_state();
        let now = Utc::now();
        let fresh = sample(now, 10.0, 1);
        let stale = sample(now - Duration::seconds(60), 900.0, 1);
        let mut runtime = ServiceRuntime::default();
        runtime.metrics.push_back(stale.clone());
        for (id, metric) in [("fresh", fresh), ("stale", stale)] {
            runtime.instances.insert(
                id.into(),
                InstanceRuntime {
                    workloads: vec![],
                    sample: metric,
                    decision: decision(now),
                },
            );
        }
        state.services.write().await.insert("svc".into(), runtime);
        let operations = OperationsState::new(state.config.operations.clone());
        let body = render_metrics(&state, &operations).await;
        assert!(body.contains("fluxscale_service_requests_per_second{service=\"svc\"} 10.000"));
        state
            .services
            .write()
            .await
            .get_mut("svc")
            .unwrap()
            .instances
            .get_mut("fresh")
            .unwrap()
            .sample
            .timestamp = now - Duration::seconds(60);
        let body = render_metrics(&state, &operations).await;
        assert!(body.contains("fluxscale_service_telemetry_fresh{service=\"svc\"} 0"));
        assert!(!body.contains("fluxscale_service_requests_per_second{service="));
    }
}
