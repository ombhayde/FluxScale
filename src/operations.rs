use crate::config::OperationsConfig;
use axum::{
    body::Body,
    extract::State,
    http::{
        header::{AUTHORIZATION, RETRY_AFTER},
        HeaderMap, HeaderName, HeaderValue, Request, StatusCode,
    },
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::json;
use std::{
    collections::{hash_map::DefaultHasher, HashMap, VecDeque},
    hash::{Hash, Hasher},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

pub const REQUEST_ID_HEADER: &str = "x-request-id";
const RATE_LIMIT_LIMIT_HEADER: &str = "x-ratelimit-limit";
const RATE_LIMIT_REMAINING_HEADER: &str = "x-ratelimit-remaining";
const RATE_LIMIT_RESET_HEADER: &str = "x-ratelimit-reset";
const WINDOW: Duration = Duration::from_secs(60);
const MAX_RATE_WINDOWS: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestClass {
    Health,
    Read,
    Ingest,
    Audit,
}

impl RequestClass {
    fn limit(self, config: &OperationsConfig) -> u32 {
        match self {
            Self::Health => config.health_requests_per_minute,
            Self::Read => config.read_requests_per_minute,
            Self::Ingest => config.ingest_requests_per_minute,
            Self::Audit => config.audit_requests_per_minute,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AuditEvent {
    pub timestamp: DateTime<Utc>,
    pub request_id: String,
    pub method: String,
    pub path: String,
    pub request_class: RequestClass,
    pub status: u16,
    pub latency_ms: u64,
    pub rate_limited: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct OperationsSnapshot {
    pub generated_at: DateTime<Utc>,
    pub rate_limiting_enabled: bool,
    pub audit_capacity: usize,
    pub events: Vec<AuditEvent>,
}

#[derive(Debug)]
struct RateWindow {
    started_at: Instant,
    accepted: u32,
}

#[derive(Debug)]
struct RateDecision {
    allowed: bool,
    limit: u32,
    remaining: u32,
    retry_after_seconds: u64,
}

#[derive(Clone)]
pub struct OperationsState {
    config: Arc<OperationsConfig>,
    audit: Arc<RwLock<VecDeque<AuditEvent>>>,
    windows: Arc<Mutex<HashMap<String, RateWindow>>>,
}

impl OperationsState {
    pub fn new(config: OperationsConfig) -> Self {
        Self {
            config: Arc::new(config),
            audit: Arc::new(RwLock::new(VecDeque::new())),
            windows: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn snapshot(&self) -> OperationsSnapshot {
        let events = self.audit.read().await.iter().rev().cloned().collect();

        OperationsSnapshot {
            generated_at: Utc::now(),
            rate_limiting_enabled: self.config.rate_limiting_enabled,
            audit_capacity: self.config.audit_capacity,
            events,
        }
    }

    async fn admit(&self, class: RequestClass, headers: &HeaderMap) -> RateDecision {
        let limit = class.limit(&self.config);

        if !self.config.rate_limiting_enabled {
            return RateDecision {
                allowed: true,
                limit,
                remaining: limit,
                retry_after_seconds: 0,
            };
        }

        let subject = credential_fingerprint(headers);
        let key = format!("{class:?}:{subject:016x}");
        let now = Instant::now();
        let mut windows = self.windows.lock().await;

        windows.retain(|_, window| now.duration_since(window.started_at) < WINDOW);
        if windows.len() >= MAX_RATE_WINDOWS && !windows.contains_key(&key) {
            return RateDecision {
                allowed: false,
                limit,
                remaining: 0,
                retry_after_seconds: 60,
            };
        }

        let window = windows.entry(key).or_insert(RateWindow {
            started_at: now,
            accepted: 0,
        });

        if now.duration_since(window.started_at) >= WINDOW {
            window.started_at = now;
            window.accepted = 0;
        }

        let elapsed = now.duration_since(window.started_at);
        let retry_after_seconds = WINDOW.saturating_sub(elapsed).as_secs().max(1);

        if window.accepted >= limit {
            return RateDecision {
                allowed: false,
                limit,
                remaining: 0,
                retry_after_seconds,
            };
        }

        window.accepted += 1;

        RateDecision {
            allowed: true,
            limit,
            remaining: limit.saturating_sub(window.accepted),
            retry_after_seconds,
        }
    }

    async fn record(&self, event: AuditEvent) {
        let mut audit = self.audit.write().await;
        audit.push_back(event);

        while audit.len() > self.config.audit_capacity {
            audit.pop_front();
        }
    }
}

pub async fn operational_guard(
    State(operations): State<OperationsState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let started_at = Instant::now();
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let request_class = classify_request(method.as_str(), &path);
    let request_id = request_id(request.headers());
    let decision = operations.admit(request_class, request.headers()).await;

    let mut response = if decision.allowed {
        next.run(request).await
    } else {
        (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "error": {
                    "code": "rate_limited",
                    "message": "Request limit exceeded for this credential and route class"
                },
                "request_id": request_id.clone()
            })),
        )
            .into_response()
    };

    insert_header(response.headers_mut(), REQUEST_ID_HEADER, &request_id);
    insert_header(
        response.headers_mut(),
        RATE_LIMIT_LIMIT_HEADER,
        &decision.limit.to_string(),
    );
    insert_header(
        response.headers_mut(),
        RATE_LIMIT_REMAINING_HEADER,
        &decision.remaining.to_string(),
    );
    insert_header(
        response.headers_mut(),
        RATE_LIMIT_RESET_HEADER,
        &decision.retry_after_seconds.to_string(),
    );

    if !decision.allowed {
        insert_header(
            response.headers_mut(),
            RETRY_AFTER.as_str(),
            &decision.retry_after_seconds.to_string(),
        );
    }

    let audit_event = AuditEvent {
        timestamp: Utc::now(),
        request_id,
        method: method.to_string(),
        path,
        request_class,
        status: response.status().as_u16(),
        latency_ms: started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
        rate_limited: !decision.allowed,
    };

    tracing::info!(
        target: "fluxscale_audit",
        request_id = %audit_event.request_id,
        method = %audit_event.method,
        path = %audit_event.path,
        request_class = ?audit_event.request_class,
        status = audit_event.status,
        rate_limited = audit_event.rate_limited,
        latency_ms = audit_event.latency_ms,
        "control-plane request completed"
    );

    operations.record(audit_event).await;

    response
}

fn classify_request(method: &str, path: &str) -> RequestClass {
    if path == "/health" || path == "/api/v1/observability/ready" {
        RequestClass::Health
    } else if path == "/api/v1/audit" {
        RequestClass::Audit
    } else if method.eq_ignore_ascii_case("POST") && path == "/api/v1/metrics" {
        RequestClass::Ingest
    } else {
        RequestClass::Read
    }
}

fn credential_fingerprint(headers: &HeaderMap) -> u64 {
    let credential = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("anonymous");
    let mut hasher = DefaultHasher::new();
    credential.hash(&mut hasher);
    hasher.finish()
}

fn request_id(headers: &HeaderMap) -> String {
    headers
        .get(REQUEST_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| valid_request_id(value))
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string())
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-' | ':')
        })
}

fn insert_header(headers: &mut HeaderMap, name: &str, value: &str) {
    let Ok(name) = HeaderName::from_bytes(name.as_bytes()) else {
        return;
    };
    let Ok(value) = HeaderValue::from_str(value) else {
        return;
    };
    headers.insert(name, value);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> OperationsConfig {
        OperationsConfig {
            rate_limiting_enabled: true,
            audit_capacity: 2,
            health_requests_per_minute: 2,
            read_requests_per_minute: 2,
            ingest_requests_per_minute: 2,
            audit_requests_per_minute: 2,
        }
    }

    #[tokio::test]
    async fn distinct_invalid_credentials_cannot_grow_windows_without_bound() {
        let operations = OperationsState::new(test_config());
        let headers = HeaderMap::new();
        assert!(operations.admit(RequestClass::Read, &headers).await.allowed);
        for index in 1..MAX_RATE_WINDOWS {
            operations.windows.lock().await.insert(
                index.to_string(),
                RateWindow {
                    started_at: Instant::now(),
                    accepted: 0,
                },
            );
        }
        let mut other = HeaderMap::new();
        other.insert(AUTHORIZATION, HeaderValue::from_static("Bearer unknown"));
        assert!(!operations.admit(RequestClass::Read, &other).await.allowed);
        assert!(operations.admit(RequestClass::Read, &headers).await.allowed);
        assert_eq!(operations.windows.lock().await.len(), MAX_RATE_WINDOWS);
    }

    #[test]
    fn request_ids_accept_safe_values_and_replace_unsafe_values() {
        let mut headers = HeaderMap::new();
        headers.insert(
            REQUEST_ID_HEADER,
            HeaderValue::from_static("client-request_1"),
        );
        assert_eq!(request_id(&headers), "client-request_1");

        headers.insert(
            REQUEST_ID_HEADER,
            HeaderValue::from_static("unsafe/request"),
        );
        assert_ne!(request_id(&headers), "unsafe/request");
    }

    #[tokio::test]
    async fn rate_limits_are_isolated_by_credential() {
        let operations = OperationsState::new(test_config());
        let mut first = HeaderMap::new();
        first.insert(AUTHORIZATION, HeaderValue::from_static("Bearer first"));
        let mut second = HeaderMap::new();
        second.insert(AUTHORIZATION, HeaderValue::from_static("Bearer second"));

        assert!(operations.admit(RequestClass::Read, &first).await.allowed);
        assert!(operations.admit(RequestClass::Read, &first).await.allowed);
        assert!(!operations.admit(RequestClass::Read, &first).await.allowed);
        assert!(operations.admit(RequestClass::Read, &second).await.allowed);
    }

    #[tokio::test]
    async fn audit_trail_is_bounded() {
        let operations = OperationsState::new(test_config());

        for index in 0..3 {
            operations
                .record(AuditEvent {
                    timestamp: Utc::now(),
                    request_id: format!("request-{index}"),
                    method: "GET".to_string(),
                    path: "/health".to_string(),
                    request_class: RequestClass::Health,
                    status: 200,
                    latency_ms: 1,
                    rate_limited: false,
                })
                .await;
        }

        let snapshot = operations.snapshot().await;
        assert_eq!(snapshot.events.len(), 2);
        assert_eq!(snapshot.events[0].request_id, "request-2");
        assert_eq!(snapshot.events[1].request_id, "request-1");
    }

    #[test]
    fn routes_use_independent_limit_classes() {
        assert_eq!(classify_request("GET", "/health"), RequestClass::Health);
        assert_eq!(
            classify_request("POST", "/api/v1/metrics"),
            RequestClass::Ingest
        );
        assert_eq!(
            classify_request("GET", "/api/v1/audit"),
            RequestClass::Audit
        );
        assert_eq!(
            classify_request("GET", "/api/v1/services"),
            RequestClass::Read
        );
    }
}
