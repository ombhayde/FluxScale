use crate::{
    auth::{AuthFailure, AuthState, Permission},
    capacity::{estimate_capacity, CapacityEstimate, CapacityPhase},
    config::IngestionConfig,
    model::{
        IngestResponse, MetricInput, MetricSample, ScalingAction, ScalingDecision, ServiceSnapshot,
        WorkloadMetric,
    },
    observability,
    operations::{operational_guard, OperationsSnapshot, OperationsState},
    scaler,
    state::{AppState, InstanceRuntime, PersistenceHealth, ServicePolicy, ServiceRuntime},
};

use axum::{
    body::Body,
    extract::{Extension, Path, State},
    http::{header::WWW_AUTHENTICATE, HeaderMap, HeaderValue, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde_json::{json, Value};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

const EXECUTION_MODE_HEADER: &str = "x-fluxscale-execution-mode";

const OBSERVE_ONLY_MODE: &str = "observe_only";

#[derive(Debug)]
enum IngestOutcome {
    Fresh(ScalingDecision),
    Duplicate(ScalingDecision),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MetricTimestampError {
    TooOld,
    TooFarInFuture,
    OutOfOrder,
}

pub fn router(state: AppState, auth: AuthState) -> Router {
    let operations = OperationsState::new(state.config.operations.clone());
    let read_routes = Router::new()
        .route("/api/v1/services/{service}/policy", get(get_policy))
        .route("/api/v1/services", get(list_services))
        .route("/api/v1/services/{service}", get(get_service))
        .route("/api/v1/services/{service}/metrics", get(get_metrics))
        .route("/api/v1/services/{service}/instances", get(get_instances))
        .route("/api/v1/services/{service}/capacity", get(get_capacity))
        .route("/api/v1/persistence", get(get_persistence))
        .route("/api/v1/backends/{service}", get(get_backends))
        .route("/api/v1/dashboard/overview", get(dashboard_overview))
        .route("/api/v1/decisions", get(list_decisions))
        .route("/api/v1/audit", get(list_audit))
        .route_layer(middleware::from_fn_with_state(auth.clone(), authorize_read));

    let ingest_route = Router::new()
        .route("/api/v1/metrics", post(ingest_metric))
        .route_layer(middleware::from_fn_with_state(
            auth.clone(),
            authorize_ingest,
        ));

    let policy_routes = Router::new()
        .route("/api/v1/services/{service}/policy", post(set_policy))
        .route_layer(middleware::from_fn_with_state(
            auth.clone(),
            authorize_managed,
        ));

    let health_route = Router::new().route("/health", get(health));

    let health_route = if auth.public_health() {
        health_route
    } else {
        health_route.route_layer(middleware::from_fn_with_state(auth.clone(), authorize_read))
    };

    let observability_routes = Router::new()
        .route(
            "/api/v1/observability/metrics",
            get(observability::metrics_handler),
        )
        .route_layer(middleware::from_fn_with_state(auth.clone(), authorize_read))
        .merge(Router::new().route(
            "/api/v1/observability/ready",
            get(observability::readiness_handler),
        ));

    Router::new()
        .merge(health_route)
        .merge(observability_routes)
        .merge(read_routes)
        .merge(ingest_route)
        .merge(policy_routes)
        .layer(if auth.enabled() {
            CorsLayer::new()
        } else {
            CorsLayer::permissive()
        })
        .layer(TraceLayer::new_for_http())
        .layer(Extension(operations.clone()))
        .layer(middleware::from_fn_with_state(
            operations,
            operational_guard,
        ))
        .with_state(state)
}

async fn get_policy(State(state): State<AppState>, Path(service): Path<String>) -> Json<Value> {
    let services = state.services.read().await;
    Json(
        json!({"policy": services.get(&service).and_then(|runtime| runtime.policy.clone()), "host_min_replicas": state.config.scaling.min_replicas, "host_max_replicas": state.config.scaling.max_replicas}),
    )
}

async fn authorize_managed(
    State(auth): State<AuthState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    match auth.authorize(request.headers(), Permission::Managed) {
        Ok(()) => next.run(request).await,
        Err(error) => auth_rejection(error, Permission::Managed),
    }
}

async fn set_policy(
    State(state): State<AppState>,
    Path(service): Path<String>,
    Json(policy): Json<ServicePolicy>,
) -> Response {
    if service.is_empty()
        || service.len() > 128
        || !service
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        || policy.version == 0
        || policy.min_replicas < state.config.scaling.min_replicas
        || policy.max_replicas > state.config.scaling.max_replicas
        || policy.min_replicas > policy.max_replicas
    {
        return api_rejection(
            StatusCode::BAD_REQUEST,
            "invalid_policy",
            "Policy must fit this host's configured replica bounds",
            false,
        );
    }
    {
        let mut services = state.services.write().await;
        let runtime = services.entry(service).or_default();
        if let Some(current) = &runtime.policy {
            if policy.version < current.version
                || (policy.version == current.version && policy != *current)
            {
                return api_rejection(
                    StatusCode::CONFLICT,
                    "policy_version_conflict",
                    "Policy version is stale or has conflicting contents",
                    false,
                );
            }
        }
        runtime.policy = Some(policy.clone());
    }
    if state.persist_now().await.is_err() {
        return api_rejection(
            StatusCode::SERVICE_UNAVAILABLE,
            "policy_not_persisted",
            "Policy could not be checkpointed; retry this version",
            false,
        );
    }
    Json(policy).into_response()
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    let persistence = state.persistence_health().await;
    let supervision = state.docker.supervision_health().await;

    Json(json!({
        "status": "ok",
        "phase": 7,
        "release": "8A",
        "version": env!("CARGO_PKG_VERSION"),
        "capabilities": {
            "audit": true,
            "observability": {
                "metrics": "/api/v1/observability/metrics",
                "ready": "/api/v1/observability/ready"
            },
            "draining": true,
            "adaptive_capacity": true,
            "secure_ingest": state.config.security.enabled
        },
        "docker": state.docker.enabled(),
        "proxy": state.config.proxy.bind,
        "dashboard_api": true,
        "adaptive_capacity": true,
        "manual_capacity_required": false,
        "non_blocking_reconciliation": true,
        "reconciliation_coalescing": true,
        "restart_topology_recovery": true,
        "in_flight_request_draining": true,
        "drain_timeout_policy": "cancel_scale_in",
        "continuous_topology_supervision": supervision,
        "ingest_integrity": {
            "deduplication_key": "service_instance_timestamp",
            "duplicate_policy": "return_original_decision",
            "out_of_order_policy": "reject",
            "max_past_age_seconds":
                state.config.ingestion.max_past_age_seconds,
            "max_future_skew_seconds":
                state.config.ingestion.max_future_skew_seconds,
            "instance_stale_after_seconds":
                state.config.ingestion.instance_stale_after_seconds
        },
        "fleet_telemetry": {
            "instance_identity": true,
            "aggregation": "fresh_instance_snapshot",
            "requests_per_second": "sum",
            "active_requests": "sum",
            "p95_latency_ms": "maximum",
            "error_rate": "traffic_weighted",
            "cpu_percent": "average",
            "memory_percent": "average"
        },
        "operations": {
            "request_id_header": "X-Request-Id",
            "audit_endpoint": "/api/v1/audit",
            "audit_capacity": state.config.operations.audit_capacity,
            "rate_limiting_enabled":
                state.config.operations.rate_limiting_enabled,
            "limits_per_minute": {
                "health": state.config.operations.health_requests_per_minute,
                "read": state.config.operations.read_requests_per_minute,
                "ingest": state.config.operations.ingest_requests_per_minute,
                "audit": state.config.operations.audit_requests_per_minute
            },
            "credential_storage": "fingerprint_only"
        },
        "durable_learning": true,
        "security": {
            "enabled": state.config.security.enabled,
            "public_health": state.config.security.public_health,
            "permissions": [
                "read",
                "ingest",
                "managed"
            ]
        },
        "persistence": persistence_json(&state, &persistence),
        "execution_modes": [
            "observe_only",
            "managed"
        ]
    }))
}

async fn authorize_read(
    State(auth): State<AuthState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    match auth.authorize(request.headers(), Permission::Read) {
        Ok(()) => next.run(request).await,
        Err(failure) => auth_rejection(failure, Permission::Read),
    }
}

async fn authorize_ingest(
    State(auth): State<AuthState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if !auth.enabled() {
        return next.run(request).await;
    }

    let required = match execution_permission(request.headers()) {
        Ok(permission) => permission,
        Err(response) => return response,
    };

    match auth.authorize(request.headers(), required) {
        Ok(()) => next.run(request).await,
        Err(failure) => auth_rejection(failure, required),
    }
}

fn execution_permission(headers: &HeaderMap) -> Result<Permission, Response> {
    let mut values = headers.get_all(EXECUTION_MODE_HEADER).iter();
    let Some(value) = values.next() else {
        return Err(api_rejection(
            StatusCode::BAD_REQUEST,
            "execution_mode_required",
            "X-FluxScale-Execution-Mode must be observe_only or managed",
            false,
        ));
    };

    if values.next().is_some() {
        return Err(api_rejection(
            StatusCode::BAD_REQUEST,
            "invalid_execution_mode",
            "Exactly one X-FluxScale-Execution-Mode header is required",
            false,
        ));
    }

    let Ok(value) = value.to_str() else {
        return Err(api_rejection(
            StatusCode::BAD_REQUEST,
            "invalid_execution_mode",
            "X-FluxScale-Execution-Mode must be observe_only or managed",
            false,
        ));
    };

    match value.trim().to_ascii_lowercase().as_str() {
        OBSERVE_ONLY_MODE => Ok(Permission::Ingest),
        "managed" => Ok(Permission::Managed),
        _ => Err(api_rejection(
            StatusCode::BAD_REQUEST,
            "invalid_execution_mode",
            "X-FluxScale-Execution-Mode must be observe_only or managed",
            false,
        )),
    }
}

fn auth_rejection(failure: AuthFailure, required: Permission) -> Response {
    match failure {
        AuthFailure::MissingOrInvalid => api_rejection(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "A valid Bearer token is required",
            true,
        ),
        AuthFailure::Forbidden => api_rejection(
            StatusCode::FORBIDDEN,
            "forbidden",
            &format!(
                "The supplied token does not have the required {} permission",
                required.as_str()
            ),
            false,
        ),
    }
}

fn api_rejection(status: StatusCode, code: &str, message: &str, authenticate: bool) -> Response {
    let mut response = (
        status,
        Json(json!({
            "error": {
                "code": code,
                "message": message
            }
        })),
    )
        .into_response();

    if authenticate {
        response
            .headers_mut()
            .insert(WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
    }

    response
}

async fn get_persistence(State(state): State<AppState>) -> Json<Value> {
    let persistence = state.persistence_health().await;
    Json(persistence_json(&state, &persistence))
}

async fn ingest_metric(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<MetricInput>,
) -> Result<(StatusCode, Json<IngestResponse>), (StatusCode, Json<Value>)> {
    validate_metric(&input)?;

    let mut observe_only = is_observe_only(&headers);
    let service = input.service.trim().to_string();
    let instance_id = input
        .instance_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let source_workloads = input.workloads.clone();
    let source_sample = MetricSample::from(input);
    let received_at = Utc::now();

    let actual_replicas = state.registry.healthy_count(&service).await;

    let outcome = {
        let mut services = state.services.write().await;

        let runtime = services.entry(service.clone()).or_default();
        observe_only |= runtime
            .policy
            .as_ref()
            .is_some_and(|policy| !policy.enabled);

        let duplicate = instance_id
            .as_deref()
            .and_then(|instance| {
                instance_duplicate_decision(runtime, instance, source_sample.timestamp.clone())
            })
            .or_else(|| {
                instance_id
                    .is_none()
                    .then(|| duplicate_decision(runtime, source_sample.timestamp.clone()))
                    .flatten()
            });

        if let Some(decision) = duplicate {
            IngestOutcome::Duplicate(decision)
        } else {
            let latest_source_timestamp = instance_id
                .as_deref()
                .and_then(|instance| runtime.instances.get(instance))
                .map(|instance| instance.sample.timestamp.clone())
                .or_else(|| {
                    instance_id
                        .is_none()
                        .then(|| {
                            runtime
                                .metrics
                                .back()
                                .map(|metric| metric.timestamp.clone())
                        })
                        .flatten()
                });

            validate_metric_timestamp(
                source_sample.timestamp.clone(),
                latest_source_timestamp,
                received_at.clone(),
                &state.config.ingestion,
            )?;

            let mut sample = if instance_id.is_some() {
                let cutoff = received_at.clone()
                    - ChronoDuration::seconds(state.config.ingestion.instance_stale_after_seconds);

                runtime
                    .instances
                    .retain(|_, instance| instance.sample.timestamp >= cutoff);

                if let Some(instance) = &instance_id {
                    runtime.instances.remove(instance);
                }

                aggregate_instance_metrics(
                    runtime
                        .instances
                        .values()
                        .map(|instance| &instance.sample)
                        .chain(std::iter::once(&source_sample)),
                    received_at,
                )
            } else {
                source_sample.clone()
            };

            if actual_replicas > 0 {
                sample.current_replicas = actual_replicas;
            }

            runtime.metrics.push_back(sample);

            while runtime.metrics.len() > state.config.scaling.history_limit {
                runtime.metrics.pop_front();
            }

            let history: Vec<_> = runtime.metrics.iter().cloned().collect();

            let mut scaling = state.config.scaling.clone();
            if let Some(policy) = &runtime.policy {
                // Host limits remain authoritative even after restoring an older checkpoint.
                scaling.min_replicas = policy
                    .min_replicas
                    .clamp(scaling.min_replicas, scaling.max_replicas);
                scaling.max_replicas = policy
                    .max_replicas
                    .clamp(scaling.min_replicas, scaling.max_replicas);
                observe_only |= !policy.enabled;
            }
            let mut decision =
                scaler::evaluate(&service, &history, &scaling, runtime.last_change_at);

            if runtime
                .policy
                .as_ref()
                .is_some_and(|policy| !policy.enabled)
            {
                decision.action = ScalingAction::Hold;
                decision.desired_replicas = decision.current_replicas;
                decision
                    .reasons
                    .push("Automatic scaling is paused by the project policy".into());
            }

            if !observe_only && decision.action != ScalingAction::Hold {
                runtime.last_change_at = Some(decision.timestamp);
            }

            runtime.decisions.push_back(decision.clone());

            while runtime.decisions.len() > 200 {
                runtime.decisions.pop_front();
            }

            if let Some(instance) = &instance_id {
                runtime.instances.insert(
                    instance.clone(),
                    InstanceRuntime {
                        workloads: source_workloads,
                        sample: source_sample.clone(),
                        decision: decision.clone(),
                    },
                );
            }

            IngestOutcome::Fresh(decision)
        }
    };

    let (decision, duplicate) = match outcome {
        IngestOutcome::Duplicate(decision) => (decision, true),
        IngestOutcome::Fresh(decision) => (decision, false),
    };

    let reconciliation_action = if duplicate {
        ScalingAction::Hold
    } else {
        decision.action.clone()
    };

    let should_reconcile = should_reconcile(
        state.docker.enabled(),
        observe_only,
        &reconciliation_action,
        actual_replicas,
        decision.desired_replicas,
    );

    if should_reconcile {
        state
            .docker
            .schedule(service.clone(), decision.desired_replicas)
            .await;
    }

    Ok((
        if duplicate {
            StatusCode::OK
        } else {
            StatusCode::ACCEPTED
        },
        Json(IngestResponse {
            accepted: true,
            duplicate,
            decision,
            execution: None,
        }),
    ))
}

fn is_observe_only(headers: &HeaderMap) -> bool {
    headers
        .get(EXECUTION_MODE_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .map(|value| value.eq_ignore_ascii_case(OBSERVE_ONLY_MODE))
        .unwrap_or(false)
}

fn should_reconcile(
    docker_enabled: bool,
    observe_only: bool,
    action: &ScalingAction,
    actual_replicas: u32,
    desired_replicas: u32,
) -> bool {
    docker_enabled
        && !observe_only
        && (*action != ScalingAction::Hold || actual_replicas != desired_replicas)
}

async fn list_services(State(state): State<AppState>) -> Json<Vec<ServiceSnapshot>> {
    let services = state.services.read().await;

    let snapshots = services
        .iter()
        .filter_map(|(name, runtime)| {
            Some(ServiceSnapshot {
                service: name.clone(),
                samples: runtime.metrics.len(),

                latest: runtime.metrics.back()?.clone(),

                latest_decision: runtime.decisions.back()?.clone(),
            })
        })
        .collect();

    Json(snapshots)
}

async fn get_service(
    State(state): State<AppState>,
    Path(service): Path<String>,
) -> Result<Json<ServiceSnapshot>, StatusCode> {
    let services = state.services.read().await;

    let runtime = services.get(&service).ok_or(StatusCode::NOT_FOUND)?;

    Ok(Json(ServiceSnapshot {
        service,
        samples: runtime.metrics.len(),

        latest: runtime
            .metrics
            .back()
            .cloned()
            .ok_or(StatusCode::NOT_FOUND)?,

        latest_decision: runtime
            .decisions
            .back()
            .cloned()
            .ok_or(StatusCode::NOT_FOUND)?,
    }))
}

async fn get_metrics(
    State(state): State<AppState>,
    Path(service): Path<String>,
) -> Result<Json<Vec<MetricSample>>, StatusCode> {
    let services = state.services.read().await;

    let runtime = services.get(&service).ok_or(StatusCode::NOT_FOUND)?;

    Ok(Json(runtime.metrics.iter().cloned().collect()))
}

async fn get_instances(
    State(state): State<AppState>,
    Path(service): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let now = Utc::now();
    let stale_after_seconds = state.config.ingestion.instance_stale_after_seconds;
    let cutoff = now - ChronoDuration::seconds(stale_after_seconds);
    let services = state.services.read().await;
    let runtime = services.get(&service).ok_or(StatusCode::NOT_FOUND)?;
    let mut instances = runtime
        .instances
        .iter()
        .map(|(instance_id, instance)| {
            json!({
                "instance_id": instance_id,
                "fresh": instance.sample.timestamp >= cutoff,
                "last_sample": &instance.sample,
                "last_decision_id": instance.decision.id.to_string()
            })
        })
        .collect::<Vec<_>>();

    instances.sort_by(|left, right| {
        left["instance_id"]
            .as_str()
            .cmp(&right["instance_id"].as_str())
    });

    Ok(Json(json!({
        "service": service,
        "instance_stale_after_seconds": stale_after_seconds,
        "instances": instances
    })))
}

async fn get_capacity(
    State(state): State<AppState>,
    Path(service): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let history: Vec<MetricSample> = {
        let services = state.services.read().await;

        let runtime = services.get(&service).ok_or(StatusCode::NOT_FOUND)?;

        runtime.metrics.iter().cloned().collect()
    };

    let estimate = estimate_capacity(&history);

    Ok(Json(json!({
        "service": service,
        "adaptive_capacity": true,
        "manual_input_required": false,
        "estimate": capacity_json(&estimate)
    })))
}

async fn get_backends(State(state): State<AppState>, Path(service): Path<String>) -> Json<Value> {
    let backends = state.registry.snapshots(&service).await;

    Json(json!({
        "service": service,
        "backends": backends
    }))
}

async fn dashboard_overview(State(state): State<AppState>) -> Json<Value> {
    let persistence = state.persistence_health().await;

    let (service_data, recent_decisions) = {
        let services = state.services.read().await;

        let service_data: Vec<_> = services
            .iter()
            .filter_map(|(service, runtime)| {
                let history: Vec<_> = runtime.metrics.iter().cloned().collect();

                Some((
                    service.clone(),
                    runtime.metrics.back()?.clone(),
                    runtime.decisions.back()?.clone(),
                    history,
                    aggregate_workloads(runtime.instances.values().filter(|instance| {
                        (Utc::now() - instance.sample.timestamp).num_seconds()
                            <= state.config.ingestion.instance_stale_after_seconds
                    })),
                ))
            })
            .collect();

        let mut recent_decisions: Vec<ScalingDecision> = services
            .values()
            .flat_map(|runtime| runtime.decisions.iter().cloned())
            .collect();

        recent_decisions.sort_by(|first, second| second.timestamp.cmp(&first.timestamp));

        recent_decisions.truncate(20);

        (service_data, recent_decisions)
    };

    let monitored_services = service_data.len();

    let mut service_rows = Vec::new();

    let mut total_rps = 0.0;
    let mut total_latency = 0.0;
    let mut total_cpu = 0.0;
    let mut total_memory = 0.0;
    let mut total_capacity_confidence = 0.0;

    let mut healthy_backends = 0usize;
    let mut healthy_services = 0usize;
    let mut degraded_services = 0usize;
    let mut critical_services = 0usize;
    let mut scaling_services = 0usize;

    let mut capacity_warming_up_services = 0usize;

    let mut capacity_learning_services = 0usize;

    let mut saturation_observed_services = 0usize;

    for (service, latest, decision, history, workloads) in service_data {
        let backends = state.registry.snapshots(&service).await;

        let healthy_count = backends.iter().filter(|backend| backend.healthy).count();

        let capacity = estimate_capacity(&history);

        match capacity.phase {
            CapacityPhase::WarmingUp => {
                capacity_warming_up_services += 1;
            }

            CapacityPhase::Learning => {
                capacity_learning_services += 1;
            }

            CapacityPhase::SaturationObserved => {
                saturation_observed_services += 1;
            }
        }

        total_capacity_confidence += capacity.confidence;

        let status = if latest.error_rate >= state.config.scaling.max_error_rate
            || latest.p95_latency_ms >= state.config.scaling.target_p95_latency_ms * 4.0
        {
            critical_services += 1;
            "critical"
        } else if latest.p95_latency_ms > state.config.scaling.target_p95_latency_ms
            || latest.error_rate >= state.config.scaling.max_error_rate * 0.5
        {
            degraded_services += 1;
            "degraded"
        } else if decision.action != ScalingAction::Hold {
            scaling_services += 1;
            "scaling"
        } else {
            healthy_services += 1;
            "healthy"
        };

        total_rps += latest.requests_per_second;

        total_latency += latest.p95_latency_ms;

        total_cpu += latest.cpu_percent;

        total_memory += latest.memory_percent;

        healthy_backends += healthy_count;

        service_rows.push(json!({
            "workloads": workloads,
            "service": service,
            "status": status,

            "requests_per_second":
                latest.requests_per_second,

            "predicted_rps":
                decision.predicted_rps,

            "prediction_horizon_seconds":
                decision.prediction_horizon_seconds,

            "p95_latency_ms":
                latest.p95_latency_ms,

            "error_rate":
                latest.error_rate,

            "cpu_percent":
                latest.cpu_percent,

            "memory_percent":
                latest.memory_percent,

            "active_requests":
                latest.active_requests,

            "current_replicas":
                latest.current_replicas,

            "desired_replicas":
                decision.desired_replicas,

            "healthy_backends":
                healthy_count,

            "action":
                decision.action,

            "decision_reasons":
                decision.reasons,

            "updated_at":
                latest.timestamp,

            "capacity":
                capacity_json(&capacity),

            "backends":
                backends
        }));
    }

    service_rows.sort_by(|left, right| {
        let left_name = left
            .get("service")
            .and_then(Value::as_str)
            .unwrap_or_default();

        let right_name = right
            .get("service")
            .and_then(Value::as_str)
            .unwrap_or_default();

        left_name.cmp(right_name)
    });

    let divisor = if monitored_services == 0 {
        1.0
    } else {
        monitored_services as f64
    };

    Json(json!({
        "generated_at": Utc::now(),

        "adaptive_capacity": {
            "enabled": true,
            "manual_input_required": false
        },

        "persistence":
            persistence_json(&state, &persistence),

        "summary": {
            "services":
                monitored_services,

            "healthy_services":
                healthy_services,

            "degraded_services":
                degraded_services,

            "critical_services":
                critical_services,

            "scaling_services":
                scaling_services,

            "healthy_backends":
                healthy_backends,

            "total_requests_per_second":
                total_rps,

            "average_p95_latency_ms":
                total_latency / divisor,

            "average_cpu_percent":
                total_cpu / divisor,

            "average_memory_percent":
                total_memory / divisor,

            "average_capacity_confidence":
                total_capacity_confidence
                    / divisor,

            "capacity_warming_up_services":
                capacity_warming_up_services,

            "capacity_learning_services":
                capacity_learning_services,

            "saturation_observed_services":
                saturation_observed_services
        },

        "services": service_rows,

        "recent_decisions":
            recent_decisions
    }))
}

async fn list_decisions(State(state): State<AppState>) -> Json<Vec<ScalingDecision>> {
    let services = state.services.read().await;

    let mut decisions: Vec<_> = services
        .values()
        .flat_map(|runtime| runtime.decisions.iter().cloned())
        .collect();

    decisions.sort_by(|first, second| second.timestamp.cmp(&first.timestamp));

    decisions.truncate(200);

    Json(decisions)
}

async fn list_audit(Extension(operations): Extension<OperationsState>) -> Json<OperationsSnapshot> {
    Json(operations.snapshot().await)
}

fn persistence_json(state: &AppState, health: &PersistenceHealth) -> Value {
    json!({
        "enabled": true,
        "status": if health.last_save_error.is_some() {
            "degraded"
        } else {
            "healthy"
        },
        "state_schema_version":
            health.state_schema_version,
        "path":
            state.persistence_path().display().to_string(),
        "restore_source":
            health.restore_source.as_str(),
        "restored_at":
            health.restored_at,
        "restored_services":
            health.restored_services,
        "restored_metric_samples":
            health.restored_metric_samples,
        "restored_decisions":
            health.restored_decisions,
        "last_successful_save_at":
            health.last_successful_save_at,
        "last_save_error":
            health.last_save_error.as_deref(),
        "last_cleanup_at":
            health.last_cleanup_at,
        "services_removed_total":
            health.services_removed_total,
        "stale_service_ttl_seconds":
            health.stale_service_ttl_seconds,
        "maintenance_interval_seconds":
            health.maintenance_interval_seconds
    })
}

fn capacity_json(estimate: &CapacityEstimate) -> Value {
    json!({
        "phase":
            estimate.phase,

        "safe_rps_per_replica":
            estimate.safe_rps_per_replica,

        "observed_peak_rps_per_replica":
            estimate.observed_peak_rps_per_replica,

        "saturation_rps_per_replica":
            estimate.saturation_rps_per_replica,

        "confidence":
            estimate.confidence,

        "confidence_percent":
            estimate.confidence * 100.0,

        "sample_count":
            estimate.sample_count,

        "healthy_samples":
            estimate.healthy_samples,

        "stressed_samples":
            estimate.stressed_samples,

        "baseline_p95_latency_ms":
            estimate.baseline_p95_latency_ms,

        "baseline_error_rate":
            estimate.baseline_error_rate,

        "manual_input_required": false
    })
}

fn aggregate_workloads<'a>(
    instances: impl Iterator<Item = &'a InstanceRuntime>,
) -> Vec<WorkloadMetric> {
    let mut totals = std::collections::BTreeMap::<String, WorkloadMetric>::new();
    for workload in instances.flat_map(|instance| &instance.workloads) {
        if !workload.is_valid() {
            continue;
        }
        let total = totals
            .entry(workload.name.clone())
            .or_insert(WorkloadMetric {
                name: workload.name.clone(),
                requests_per_second: 0.0,
                completed_requests: 0,
                failed_requests: 0,
                p95_latency_ms: 0.0,
            });
        total.requests_per_second += workload.requests_per_second;
        total.completed_requests = total
            .completed_requests
            .saturating_add(workload.completed_requests);
        total.failed_requests = total
            .failed_requests
            .saturating_add(workload.failed_requests);
        total.p95_latency_ms = total.p95_latency_ms.max(workload.p95_latency_ms);
    }
    totals.into_values().take(8).collect()
}

fn validate_metric(input: &MetricInput) -> Result<(), (StatusCode, Json<Value>)> {
    let valid = !input.service.trim().is_empty()
        && input.requests_per_second.is_finite()
        && input.requests_per_second >= 0.0
        && input.p95_latency_ms.is_finite()
        && input.p95_latency_ms >= 0.0
        && input.error_rate.is_finite()
        && (0.0..=1.0).contains(&input.error_rate)
        && input.cpu_percent.is_finite()
        && (0.0..=100.0).contains(&input.cpu_percent)
        && input.memory_percent.is_finite()
        && (0.0..=100.0).contains(&input.memory_percent)
        && input.current_replicas > 0
        && input.instance_id.as_deref().is_none_or(valid_instance_id)
        && input.workloads.len() <= 8
        && input.workloads.iter().all(WorkloadMetric::is_valid)
        && input
            .workloads
            .iter()
            .map(|w| &w.name)
            .collect::<std::collections::HashSet<_>>()
            .len()
            == input.workloads.len()
        && (input.workloads.is_empty() || input.instance_id.is_some());

    if valid {
        Ok(())
    } else {
        Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "error":
                    "invalid metric payload"
            })),
        ))
    }
}

fn valid_instance_id(value: &str) -> bool {
    let value = value.trim();

    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-' | ':')
        })
}

fn duplicate_decision(
    runtime: &ServiceRuntime,
    timestamp: DateTime<Utc>,
) -> Option<ScalingDecision> {
    let duplicate = runtime
        .metrics
        .iter()
        .any(|sample| sample.timestamp == timestamp);

    if !duplicate {
        return None;
    }

    runtime
        .decisions
        .iter()
        .rev()
        .find(|decision| decision.timestamp == timestamp)
        .cloned()
}

fn instance_duplicate_decision(
    runtime: &ServiceRuntime,
    instance_id: &str,
    timestamp: DateTime<Utc>,
) -> Option<ScalingDecision> {
    runtime.instances.get(instance_id).and_then(|instance| {
        (instance.sample.timestamp == timestamp).then(|| instance.decision.clone())
    })
}

pub(crate) fn aggregate_instance_metrics<'a>(
    samples: impl Iterator<Item = &'a MetricSample>,
    timestamp: DateTime<Utc>,
) -> MetricSample {
    let samples: Vec<_> = samples.collect();
    let instance_count = samples.len().max(1) as f64;
    let requests_per_second = samples
        .iter()
        .map(|sample| sample.requests_per_second)
        .sum::<f64>();
    let weighted_errors = samples
        .iter()
        .map(|sample| sample.error_rate * sample.requests_per_second)
        .sum::<f64>();

    MetricSample {
        timestamp,
        requests_per_second,
        active_requests: samples.iter().map(|sample| sample.active_requests).sum(),
        p95_latency_ms: samples
            .iter()
            .map(|sample| sample.p95_latency_ms)
            .fold(0.0, f64::max),
        error_rate: if requests_per_second > 0.0 {
            weighted_errors / requests_per_second
        } else {
            samples.iter().map(|sample| sample.error_rate).sum::<f64>() / instance_count
        },
        cpu_percent: samples.iter().map(|sample| sample.cpu_percent).sum::<f64>() / instance_count,
        memory_percent: samples
            .iter()
            .map(|sample| sample.memory_percent)
            .sum::<f64>()
            / instance_count,
        current_replicas: samples
            .iter()
            .map(|sample| sample.current_replicas)
            .max()
            .unwrap_or(1)
            .max(samples.len() as u32),
    }
}

fn validate_metric_timestamp(
    timestamp: DateTime<Utc>,
    latest_timestamp: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
    config: &IngestionConfig,
) -> Result<(), (StatusCode, Json<Value>)> {
    let earliest = now - ChronoDuration::seconds(config.max_past_age_seconds);
    let latest = now + ChronoDuration::seconds(config.max_future_skew_seconds);

    let error = if timestamp < earliest {
        Some(MetricTimestampError::TooOld)
    } else if timestamp > latest {
        Some(MetricTimestampError::TooFarInFuture)
    } else if latest_timestamp.is_some_and(|previous| timestamp <= previous) {
        Some(MetricTimestampError::OutOfOrder)
    } else {
        None
    };

    match error {
        None => Ok(()),
        Some(MetricTimestampError::TooOld) => Err(metric_timestamp_rejection(
            StatusCode::UNPROCESSABLE_ENTITY,
            "metric_too_old",
            "Metric timestamp is older than the configured ingestion window",
        )),
        Some(MetricTimestampError::TooFarInFuture) => Err(metric_timestamp_rejection(
            StatusCode::UNPROCESSABLE_ENTITY,
            "metric_from_future",
            "Metric timestamp exceeds the configured future clock-skew allowance",
        )),
        Some(MetricTimestampError::OutOfOrder) => Err(metric_timestamp_rejection(
            StatusCode::CONFLICT,
            "metric_out_of_order",
            "Metric timestamp is not newer than the latest accepted sample for this service",
        )),
    }
}

fn metric_timestamp_rejection(
    status: StatusCode,
    code: &str,
    message: &str,
) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(json!({
            "error": {
                "code": code,
                "message": message
            }
        })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::MetricSample;
    use std::collections::VecDeque;
    use uuid::Uuid;

    fn sample(timestamp: DateTime<Utc>) -> MetricSample {
        MetricSample {
            timestamp,
            requests_per_second: 100.0,
            active_requests: 1,
            p95_latency_ms: 25.0,
            error_rate: 0.0,
            cpu_percent: 20.0,
            memory_percent: 30.0,
            current_replicas: 1,
        }
    }

    fn decision(timestamp: DateTime<Utc>) -> ScalingDecision {
        ScalingDecision {
            id: Uuid::new_v4(),
            service: "checkout".into(),
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

    #[test]
    fn workload_metrics_are_bounded_and_combined_without_inventing_a_fleet_percentile() {
        let now = Utc::now();
        let first = InstanceRuntime {
            sample: sample(now),
            decision: decision(now),
            workloads: vec![WorkloadMetric {
                name: "read".into(),
                requests_per_second: 5.0,
                completed_requests: 10,
                failed_requests: 1,
                p95_latency_ms: 30.0,
            }],
        };
        let mut second = first.clone();
        second.workloads[0].requests_per_second = 7.0;
        second.workloads[0].completed_requests = 14;
        second.workloads[0].failed_requests = 0;
        second.workloads[0].p95_latency_ms = 50.0;
        let combined = aggregate_workloads([&first, &second].into_iter());
        assert_eq!(combined[0].requests_per_second, 12.0);
        assert_eq!(combined[0].completed_requests, 24);
        assert_eq!(combined[0].failed_requests, 1);
        assert_eq!(combined[0].p95_latency_ms, 50.0);
        let mut input: MetricInput = serde_json::from_value(json!({ "service": "orders", "instance_id": "one", "requests_per_second": 5.0, "current_replicas": 1, "workloads": first.workloads })).unwrap();
        assert!(validate_metric(&input).is_ok());
        input.workloads.push(input.workloads[0].clone());
        assert!(validate_metric(&input).is_err());
        input.workloads.pop();
        input.workloads[0].failed_requests = 100;
        assert!(validate_metric(&input).is_err());
    }

    #[test]
    fn managed_hold_repairs_topology_drift() {
        assert!(should_reconcile(true, false, &ScalingAction::Hold, 1, 3,));
    }

    #[test]
    fn matching_managed_hold_does_not_schedule_redundant_work() {
        assert!(!should_reconcile(true, false, &ScalingAction::Hold, 3, 3,));
    }

    #[test]
    fn observe_only_never_reconciles_docker() {
        assert!(!should_reconcile(true, true, &ScalingAction::ScaleUp, 1, 3,));
    }

    #[test]
    fn duplicate_timestamp_returns_the_original_decision() {
        let timestamp = Utc::now();
        let original = decision(timestamp.clone());
        let runtime = ServiceRuntime {
            metrics: VecDeque::from([sample(timestamp.clone())]),
            decisions: VecDeque::from([original.clone()]),
            last_change_at: None,
            ..ServiceRuntime::default()
        };

        let replayed = duplicate_decision(&runtime, timestamp).unwrap();
        assert_eq!(replayed.id, original.id);
    }

    #[tokio::test]
    async fn project_policy_is_bounded_idempotent_durable_and_pauses_real_actions() {
        let mut config = crate::config::Config::default();
        config.docker.enabled = false;
        config.scaling.min_replicas = 1;
        config.scaling.max_replicas = 3;
        let path =
            std::env::temp_dir().join(format!("fluxscale-policy-{}.json", uuid::Uuid::new_v4()));
        let state = AppState::with_persistence_path(config.clone(), path.clone());
        let policy = ServicePolicy {
            version: 1,
            enabled: false,
            min_replicas: 1,
            max_replicas: 3,
        };
        for _ in 0..2 {
            assert_eq!(
                set_policy(
                    State(state.clone()),
                    Path("orders".into()),
                    Json(policy.clone())
                )
                .await
                .status(),
                StatusCode::OK
            );
        }
        let mut conflict = policy.clone();
        conflict.enabled = true;
        assert_eq!(
            set_policy(State(state.clone()), Path("orders".into()), Json(conflict))
                .await
                .status(),
            StatusCode::CONFLICT
        );
        let mut excessive = policy.clone();
        excessive.version = 2;
        excessive.max_replicas = 4;
        assert_eq!(
            set_policy(State(state.clone()), Path("orders".into()), Json(excessive))
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        let restored = AppState::with_persistence_path(config, path.clone());
        restored.restore().await.unwrap();
        assert_eq!(
            restored.services.read().await["orders"].policy,
            Some(policy)
        );
        let input: MetricInput = serde_json::from_value(json!({"service":"orders","requests_per_second":1000,"current_replicas":1,"p95_latency_ms":10000})).unwrap();
        let (_, Json(response)) =
            ingest_metric(State(restored.clone()), HeaderMap::new(), Json(input))
                .await
                .unwrap();
        assert_eq!(response.decision.action, ScalingAction::Hold);
        assert_eq!(response.decision.desired_replicas, 1);
        assert!(restored.services.read().await["orders"]
            .last_change_at
            .is_none());
        assert!(restored.cleanup_stale_services().await.removed.is_empty());
        let _ = tokio::fs::remove_file(&path).await;
        let _ = tokio::fs::remove_file(path.with_file_name(format!(
            "{}.bak",
            path.file_name().unwrap().to_string_lossy()
        )))
        .await;
    }

    #[test]
    fn rejects_out_of_order_timestamp() {
        let now = Utc::now();
        let config = IngestionConfig::default();
        let result = validate_metric_timestamp(
            now - ChronoDuration::seconds(2),
            Some(now - ChronoDuration::seconds(1)),
            now,
            &config,
        );

        assert_eq!(result.unwrap_err().0, StatusCode::CONFLICT);
    }

    #[test]
    fn rejects_stale_and_future_timestamps() {
        let now = Utc::now();
        let config = IngestionConfig::default();

        let stale = validate_metric_timestamp(
            now - ChronoDuration::seconds(config.max_past_age_seconds + 1),
            None,
            now,
            &config,
        );
        let future = validate_metric_timestamp(
            now + ChronoDuration::seconds(config.max_future_skew_seconds + 1),
            None,
            now,
            &config,
        );

        assert_eq!(stale.unwrap_err().0, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(future.unwrap_err().0, StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn accepts_monotonic_timestamp_within_the_window() {
        let now = Utc::now();
        let config = IngestionConfig::default();
        let result = validate_metric_timestamp(
            now - ChronoDuration::seconds(1),
            Some(now - ChronoDuration::seconds(2)),
            now,
            &config,
        );

        assert!(result.is_ok());
    }

    #[test]
    fn fleet_aggregation_combines_distinct_instances() {
        let timestamp = Utc::now();
        let mut first = sample(timestamp.clone());
        first.requests_per_second = 100.0;
        first.active_requests = 2;
        first.p95_latency_ms = 40.0;
        first.error_rate = 0.01;
        first.cpu_percent = 20.0;

        let mut second = sample(timestamp.clone());
        second.requests_per_second = 300.0;
        second.active_requests = 4;
        second.p95_latency_ms = 90.0;
        second.error_rate = 0.03;
        second.cpu_percent = 40.0;

        let aggregate = aggregate_instance_metrics([&first, &second].into_iter(), timestamp);

        assert_eq!(aggregate.requests_per_second, 400.0);
        assert_eq!(aggregate.active_requests, 6);
        assert_eq!(aggregate.p95_latency_ms, 90.0);
        assert!((aggregate.error_rate - 0.025).abs() < f64::EPSILON);
        assert_eq!(aggregate.cpu_percent, 30.0);
        assert_eq!(aggregate.current_replicas, 2);
    }

    #[test]
    fn duplicate_scope_includes_instance_identity() {
        let timestamp = Utc::now();
        let original = decision(timestamp.clone());
        let mut runtime = ServiceRuntime::default();
        runtime.instances.insert(
            "replica-a".into(),
            InstanceRuntime {
                workloads: vec![],
                sample: sample(timestamp.clone()),
                decision: original.clone(),
            },
        );

        let replayed = instance_duplicate_decision(&runtime, "replica-a", timestamp).unwrap();
        assert_eq!(replayed.id, original.id);
        assert!(instance_duplicate_decision(&runtime, "replica-b", timestamp).is_none());
    }

    #[test]
    fn instance_identity_rejects_unsafe_characters() {
        assert!(valid_instance_id("checkout-host-42"));
        assert!(!valid_instance_id("../../other-service"));
        assert!(!valid_instance_id("   "));
    }
}
