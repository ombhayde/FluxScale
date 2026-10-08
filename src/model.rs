use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize)]
pub struct MetricInput {
    pub service: String,
    #[serde(default)]
    pub instance_id: Option<String>,
    #[serde(default)]
    pub timestamp: Option<DateTime<Utc>>,
    pub requests_per_second: f64,
    #[serde(default)]
    pub active_requests: u64,
    #[serde(default)]
    pub p95_latency_ms: f64,
    #[serde(default)]
    pub error_rate: f64,
    #[serde(default)]
    pub cpu_percent: f64,
    #[serde(default)]
    pub memory_percent: f64,
    pub current_replicas: u32,
    #[serde(default)]
    pub workloads: Vec<WorkloadMetric>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkloadMetric {
    pub name: String,
    pub requests_per_second: f64,
    pub completed_requests: u64,
    pub failed_requests: u64,
    pub p95_latency_ms: f64,
}

impl WorkloadMetric {
    pub fn is_valid(&self) -> bool {
        !self.name.is_empty()
            && self.name.len() <= 32
            && self
                .name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
            && self.requests_per_second.is_finite()
            && (0.0..=1_000_000_000.0).contains(&self.requests_per_second)
            && self.p95_latency_ms.is_finite()
            && (0.0..=86_400_000.0).contains(&self.p95_latency_ms)
            && self.completed_requests <= 1_000_000_000
            && self.failed_requests <= self.completed_requests
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricSample {
    pub timestamp: DateTime<Utc>,
    pub requests_per_second: f64,
    pub active_requests: u64,
    pub p95_latency_ms: f64,
    pub error_rate: f64,
    pub cpu_percent: f64,
    pub memory_percent: f64,
    pub current_replicas: u32,
}

impl From<MetricInput> for MetricSample {
    fn from(value: MetricInput) -> Self {
        Self {
            timestamp: value.timestamp.unwrap_or_else(Utc::now),
            requests_per_second: value.requests_per_second,
            active_requests: value.active_requests,
            p95_latency_ms: value.p95_latency_ms,
            error_rate: value.error_rate,
            cpu_percent: value.cpu_percent,
            memory_percent: value.memory_percent,
            current_replicas: value.current_replicas,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScalingAction {
    ScaleUp,
    ScaleDown,
    Hold,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScalingDecision {
    pub id: Uuid,
    pub service: String,
    pub timestamp: DateTime<Utc>,
    pub action: ScalingAction,
    pub current_replicas: u32,
    pub desired_replicas: u32,
    pub current_rps: f64,
    pub predicted_rps: f64,
    pub prediction_horizon_seconds: i64,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackendSnapshot {
    pub name: String,
    pub url: String,
    pub healthy: bool,
    pub draining: bool,
    pub active_requests: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExecutionReport {
    pub current_before: u32,
    pub desired: u32,
    pub started: Vec<String>,
    pub stopped: Vec<String>,
    pub backends: Vec<BackendSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceSnapshot {
    pub service: String,
    pub samples: usize,
    pub latest: MetricSample,
    pub latest_decision: ScalingDecision,
}

#[derive(Debug, Serialize)]
pub struct IngestResponse {
    pub accepted: bool,
    pub duplicate: bool,
    pub decision: ScalingDecision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<ExecutionReport>,
}
