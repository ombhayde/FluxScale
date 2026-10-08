use crate::backend::BackendRegistry;
use axum::{
    body::{to_bytes, Body},
    extract::{Path, State},
    http::{header, Request, Response, StatusCode},
    response::IntoResponse,
    routing::any,
    Router,
};
use serde_json::json;

#[derive(Clone)]
struct ProxyState {
    registry: BackendRegistry,
    client: reqwest::Client,
    max_body_bytes: usize,
}

pub fn router(registry: BackendRegistry, max_body_bytes: usize) -> Router {
    let state = ProxyState {
        registry,
        client: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("valid proxy HTTP client"),
        max_body_bytes,
    };
    Router::new()
        .route("/{service}", any(proxy_root))
        .route("/{service}/{*path}", any(proxy_path))
        .with_state(state)
}

async fn proxy_root(
    State(state): State<ProxyState>,
    Path(service): Path<String>,
    request: Request<Body>,
) -> Response<Body> {
    forward(state, service, String::new(), request).await
}

async fn proxy_path(
    State(state): State<ProxyState>,
    Path((service, path)): Path<(String, String)>,
    request: Request<Body>,
) -> Response<Body> {
    forward(state, service, path, request).await
}

async fn forward(
    state: ProxyState,
    service: String,
    path: String,
    request: Request<Body>,
) -> Response<Body> {
    let Some(lease) = state.registry.select(&service).await else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "no healthy backend is available",
        );
    };
    let mut lease = lease;
    let (parts, body) = request.into_parts();
    let query = parts
        .uri
        .query()
        .map(|query| format!("?{query}"))
        .unwrap_or_default();
    let bytes = match to_bytes(body, state.max_body_bytes).await {
        Ok(bytes) => bytes,
        Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "request body is too large"),
    };
    let retry_safe =
        parts.method == axum::http::Method::GET || parts.method == axum::http::Method::HEAD;
    let mut attempts = 0;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut response = loop {
        let backend_url = lease.backend().url();
        let url = if path.is_empty() {
            format!("{backend_url}/{query}")
        } else {
            format!("{backend_url}/{path}{query}")
        };
        let mut outgoing = state
            .client
            .request(parts.method.clone(), url)
            .body(bytes.clone())
            .timeout(deadline.saturating_duration_since(tokio::time::Instant::now()));
        for (name, value) in &parts.headers {
            if name != header::HOST && !hop_by_hop(name, &parts.headers) {
                outgoing = outgoing.header(name, value);
            }
        }
        match outgoing.send().await {
            Ok(response) => break response,
            Err(error_value) => {
                tracing::warn!(backend = lease.backend().name(), error = ?error_value, "proxy backend transport failed");
                lease.backend().set_healthy(false);
                // Retry only read methods; replaying a mutation may duplicate application work.
                if retry_safe && attempts == 0 {
                    if let Some(next) = state.registry.select(&service).await {
                        lease = next;
                        attempts += 1;
                        continue;
                    }
                }
                return error(
                    StatusCode::BAD_GATEWAY,
                    &format!("backend request failed: {error_value}"),
                );
            }
        }
    };
    let status = response.status();
    let headers = response.headers().clone();
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if chunk.len() <= state.max_body_bytes.saturating_sub(body.len()) => {
                body.extend_from_slice(&chunk)
            }
            Ok(Some(_)) => {
                return error(
                    StatusCode::BAD_GATEWAY,
                    "backend response body is too large",
                )
            }
            Ok(None) => break,
            Err(_) => return error(StatusCode::BAD_GATEWAY, "backend response failed"),
        }
    }
    let mut result = Response::builder().status(status);
    for (name, value) in &headers {
        if !hop_by_hop(name, &headers) {
            result = result.header(name, value);
        }
    }
    result.body(Body::from(body)).unwrap_or_else(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to build proxy response",
        )
    })
}

fn hop_by_hop(name: &header::HeaderName, headers: &axum::http::HeaderMap) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "content-length"
    ) || headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|value| value.trim().eq_ignore_ascii_case(name.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn retries_a_failed_read_once_without_replaying_a_mutation() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let good = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/",
                    any(move || {
                        let counter = counter.clone();
                        async move {
                            counter.fetch_add(1, Ordering::SeqCst);
                            "ok"
                        }
                    }),
                ),
            )
            .await
            .unwrap();
        });
        let unavailable = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let bad = unavailable.local_addr().unwrap();
        drop(unavailable);
        for (method, expected_status, expected_calls) in [
            (axum::http::Method::GET, StatusCode::OK, 1),
            (axum::http::Method::HEAD, StatusCode::OK, 2),
            (axum::http::Method::POST, StatusCode::BAD_GATEWAY, 2),
        ] {
            let registry = BackendRegistry::default();
            registry
                .replace_service(
                    "svc",
                    vec![
                        ("unavailable".into(), format!("http://{bad}"), true),
                        ("available".into(), format!("http://{good}"), true),
                    ],
                )
                .await;
            let state = ProxyState {
                registry: registry.clone(),
                client: reqwest::Client::new(),
                max_body_bytes: 1024,
            };
            let response = forward(
                state,
                "svc".into(),
                String::new(),
                Request::builder()
                    .method(method)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
            assert_eq!(response.status(), expected_status);
            assert_eq!(calls.load(Ordering::SeqCst), expected_calls);
            assert!(registry
                .snapshots("svc")
                .await
                .iter()
                .all(|backend| backend.active_requests == 0));
        }
        task.abort();
    }

    #[tokio::test]
    async fn bounds_response_buffer_and_preserves_redirects() {
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = upstream.local_addr().unwrap();
        let upstream_task = tokio::spawn(async move {
            axum::serve(
                upstream,
                Router::new()
                    .route("/", any(|| async { "12345678" }))
                    .route("/large", any(|| async { "123456789" }))
                    .route(
                        "/redirect",
                        any(|| async { (StatusCode::FOUND, [(header::LOCATION, "/")]) }),
                    ),
            )
            .await
            .unwrap();
        });
        let registry = BackendRegistry::default();
        registry
            .replace_service(
                "svc",
                vec![("backend".into(), format!("http://{address}"), true)],
            )
            .await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let proxy_task = tokio::spawn(async move {
            axum::serve(listener, router(registry, 8)).await.unwrap();
        });
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let root = format!("http://{address}/svc");
        assert_eq!(
            client
                .get(&root)
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "12345678"
        );
        assert_eq!(
            client
                .get(format!("{root}/large"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(
            client
                .get(format!("{root}/redirect"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FOUND
        );
        proxy_task.abort();
        upstream_task.abort();
    }

    #[test]
    fn strips_connection_nominated_headers() {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(header::CONNECTION, "keep-alive, x-private".parse().unwrap());
        assert!(hop_by_hop(
            &header::HeaderName::from_static("x-private"),
            &headers
        ));
        assert!(hop_by_hop(&header::TRANSFER_ENCODING, &headers));
        assert!(!hop_by_hop(&header::CONTENT_TYPE, &headers));
    }
}

fn error(status: StatusCode, message: &str) -> Response<Body> {
    (status, axum::Json(json!({"error": message}))).into_response()
}
