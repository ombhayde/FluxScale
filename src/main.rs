use fluxscale_core::{
    api,
    auth::AuthState,
    config::Config,
    proxy,
    state::{AppState, RestoreSource},
};
use std::time::Duration;
use tokio::net::TcpListener;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

const PERSISTENCE_INTERVAL: Duration = Duration::from_secs(5);

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "fluxscale_core=info,tower_http=info".into()),
        )
        .init();

    let config_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "fluxscale.toml".to_string());
    let config = Config::load(config_path)?;
    let auth = AuthState::load(&config.security)?;
    let control_bind = config.server.bind.clone();
    let proxy_bind = config.proxy.bind.clone();
    let dashboard_path = config.server.dashboard_path.clone();
    if let Some(path) = &dashboard_path {
        if !std::path::Path::new(path).join("index.html").is_file() {
            return Err(format!(
                "dashboard build is missing at {path}; run npm run build in dashboard-react"
            )
            .into());
        }
    }
    let state = AppState::new(config);
    let restore = state.restore().await?;

    match restore.source {
        RestoreSource::Empty => info!(
            path = %state.persistence_path().display(),
            "no persisted runtime state found; starting with an empty learning history"
        ),
        RestoreSource::Primary => info!(
            services = restore.services,
            metric_samples = restore.metric_samples,
            decisions = restore.decisions,
            path = %state.persistence_path().display(),
            "restored FluxScale runtime state"
        ),
        RestoreSource::Backup => warn!(
            services = restore.services,
            metric_samples = restore.metric_samples,
            decisions = restore.decisions,
            path = %state.persistence_path().display(),
            "restored FluxScale runtime state from backup"
        ),
    }

    if let Some(quarantined) = &restore.quarantined_file {
        warn!(
            path = %quarantined.display(),
            "the unreadable state file was preserved for inspection"
        );
    }

    if state.docker.enabled() {
        match state.docker.restore_registry().await {
            Ok(report) => {
                let recovered_targets = {
                    let services = state.services.read().await;

                    report
                        .service_names
                        .iter()
                        .filter_map(|service| {
                            services
                                .get(service)
                                .and_then(|runtime| runtime.decisions.back())
                                .map(|decision| (service.clone(), decision.desired_replicas))
                        })
                        .collect::<Vec<_>>()
                };

                for (service, desired) in recovered_targets {
                    state.docker.set_target(service, desired).await;
                }

                info!(
                    services = report.services,
                    containers = report.containers,
                    healthy_backends = report.healthy_backends,
                    "recovered managed Docker topology into the proxy registry"
                );
            }
            Err(error) => warn!(
                error = %error,
                "managed Docker topology recovery failed; a later managed metric will retry reconciliation"
            ),
        }
    }

    // Verify this process can checkpoint before accepting telemetry.
    state.persist_now().await?;
    let control_listener = TcpListener::bind(&control_bind).await?;
    let proxy_listener = TcpListener::bind(&proxy_bind).await?;
    fluxscale_core::observability::mark_started();

    info!(address = %control_bind, "FluxScale durable control API started");
    info!(address = %proxy_bind, "FluxScale health-aware proxy started");
    info!(
        enabled = auth.enabled(),
        public_health = auth.public_health(),
        "FluxScale API permission boundary configured"
    );
    info!(
        metrics = "/api/v1/observability/metrics",
        ready = "/api/v1/observability/ready",
        "Phase 8A observability and readiness endpoints enabled"
    );
    info!(
        path = %state.persistence_path().display(),
        interval_seconds = PERSISTENCE_INTERVAL.as_secs(),
        "durable adaptive-capacity persistence enabled"
    );
    info!(
        stale_service_ttl_seconds = state.stale_service_ttl().as_secs(),
        maintenance_interval_seconds = state.maintenance_interval().as_secs(),
        "safe stale-service retention enabled"
    );
    info!(
        enabled = state.docker.supervision_enabled(),
        interval_seconds = state.config.docker.supervision_interval_seconds,
        unhealthy_threshold = state.config.docker.unhealthy_threshold,
        "continuous managed-topology supervision configured"
    );
    info!(
        rate_limiting_enabled = state.config.operations.rate_limiting_enabled,
        audit_capacity = state.config.operations.audit_capacity,
        read_requests_per_minute = state.config.operations.read_requests_per_minute,
        ingest_requests_per_minute = state.config.operations.ingest_requests_per_minute,
        "control-plane request correlation, audit trail and rate limiting configured"
    );

    let persistence_task = state.spawn_persistence_task(PERSISTENCE_INTERVAL);
    let retention_task = state.spawn_retention_task();
    let supervision_task = state.docker.spawn_supervision_task();
    let control_state = state.clone();
    let proxy_registry = state.registry.clone();
    let max_body_bytes = state.config.proxy.max_body_bytes;
    let mut control_router = api::router(control_state, auth);
    if let Some(path) = dashboard_path {
        control_router = control_router.fallback_service(tower_http::services::ServeDir::new(path));
    }

    let server_result: Result<(), std::io::Error> = tokio::select! {
        result = axum::serve(control_listener, control_router) => result,
        result = axum::serve(proxy_listener, proxy::router(proxy_registry, max_body_bytes)) => result,
        _ = tokio::signal::ctrl_c() => {
            info!("shutdown signal received");
            Ok(())
        },
    };

    persistence_task.abort();
    retention_task.abort();
    if let Some(task) = supervision_task {
        task.abort();
    }

    if let Err(error) = state.persist_now().await {
        warn!(error = %error, "final runtime-state persistence failed");
        return Err(error.into());
    }

    info!(
        path = %state.persistence_path().display(),
        "final runtime state persisted"
    );

    server_result?;
    Ok(())
}
