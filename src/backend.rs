use crate::model::BackendSnapshot;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, AtomicU8, Ordering},
        Arc,
    },
};
use tokio::{
    sync::RwLock,
    time::{sleep, Duration, Instant},
};

const UNAVAILABLE: u8 = 0;
const READY: u8 = 1;
const DRAINING: u8 = 2;

#[derive(Debug)]
pub struct Backend {
    name: String,
    url: String,
    state: AtomicU8,
    active_requests: AtomicU64,
}

impl Backend {
    fn new(name: String, url: String, healthy: bool) -> Self {
        Self {
            name,
            url,
            state: AtomicU8::new(if healthy { READY } else { UNAVAILABLE }),
            active_requests: AtomicU64::new(0),
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn set_healthy(&self, healthy: bool) {
        let next = if healthy { READY } else { UNAVAILABLE };

        // A health refresh must never accidentally put a backend that is being
        // drained back into the proxy's candidate set.
        let _ = self
            .state
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current != DRAINING).then_some(next)
            });
    }

    fn mark_draining(&self) {
        self.state.store(DRAINING, Ordering::Release);
    }

    fn cancel_draining(&self) {
        let _ = self
            .state
            .compare_exchange(DRAINING, READY, Ordering::AcqRel, Ordering::Acquire);
    }

    fn try_acquire(self: &Arc<Self>) -> Option<BackendLease> {
        if self.state.load(Ordering::Acquire) != READY {
            return None;
        }

        self.active_requests.fetch_add(1, Ordering::AcqRel);

        // mark_draining may race with selection. Rechecking after increment
        // guarantees either the new request backs out, or the drainer observes
        // it in active_requests and waits for its lease to be released.
        if self.state.load(Ordering::Acquire) == READY {
            Some(BackendLease {
                backend: self.clone(),
            })
        } else {
            self.active_requests.fetch_sub(1, Ordering::AcqRel);
            None
        }
    }

    fn snapshot(&self) -> BackendSnapshot {
        let state = self.state.load(Ordering::Acquire);

        BackendSnapshot {
            name: self.name.clone(),
            url: self.url.clone(),
            healthy: state == READY,
            draining: state == DRAINING,
            active_requests: self.active_requests.load(Ordering::Acquire),
        }
    }
}

pub struct BackendLease {
    backend: Arc<Backend>,
}

impl BackendLease {
    pub fn backend(&self) -> &Backend {
        &self.backend
    }
}

impl Drop for BackendLease {
    fn drop(&mut self) {
        let previous = self.backend.active_requests.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "backend lease counter underflow");
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DrainStatus {
    pub drained: bool,
    pub remaining_active_requests: u64,
}

#[derive(Clone, Default)]
pub struct BackendRegistry {
    services: Arc<RwLock<HashMap<String, Vec<Arc<Backend>>>>>,
    cursors: Arc<RwLock<HashMap<String, usize>>>,
}

impl BackendRegistry {
    pub async fn replace_service(&self, service: &str, entries: Vec<(String, String, bool)>) {
        let mut services = self.services.write().await;
        let existing = services.get(service).cloned().unwrap_or_default();
        let mut next = Vec::with_capacity(entries.len());

        for (name, url, healthy) in entries {
            if let Some(backend) = existing
                .iter()
                .find(|item| item.name == name && item.url == url)
            {
                backend.set_healthy(healthy);
                next.push(backend.clone());
            } else {
                next.push(Arc::new(Backend::new(name, url, healthy)));
            }
        }

        services.insert(service.to_string(), next);
    }

    pub async fn select(&self, service: &str) -> Option<BackendLease> {
        let candidates = self.services.read().await.get(service)?.clone();

        if candidates.is_empty() {
            return None;
        }

        let start = {
            let mut cursors = self.cursors.write().await;
            let cursor = cursors.entry(service.to_string()).or_default();
            let start = *cursor % candidates.len();
            *cursor = cursor.wrapping_add(1);
            start
        };

        for offset in 0..candidates.len() {
            let index = (start + offset) % candidates.len();

            if let Some(lease) = candidates[index].try_acquire() {
                return Some(lease);
            }
        }

        None
    }

    pub async fn snapshots(&self, service: &str) -> Vec<BackendSnapshot> {
        self.services
            .read()
            .await
            .get(service)
            .map(|backends| backends.iter().map(|backend| backend.snapshot()).collect())
            .unwrap_or_default()
    }

    pub async fn healthy_count(&self, service: &str) -> u32 {
        self.snapshots(service)
            .await
            .iter()
            .filter(|item| item.healthy)
            .count() as u32
    }

    pub async fn mark_draining(&self, service: &str, names: &[String]) {
        if let Some(backends) = self.services.read().await.get(service) {
            for backend in backends.iter().filter(|item| names.contains(&item.name)) {
                backend.mark_draining();
            }
        }
    }

    pub async fn cancel_draining(&self, service: &str, names: &[String]) {
        if let Some(backends) = self.services.read().await.get(service) {
            for backend in backends.iter().filter(|item| names.contains(&item.name)) {
                backend.cancel_draining();
            }
        }
    }

    pub async fn wait_drained(
        &self,
        service: &str,
        names: &[String],
        timeout: Duration,
    ) -> DrainStatus {
        let deadline = Instant::now() + timeout;

        loop {
            let active = self
                .snapshots(service)
                .await
                .into_iter()
                .filter(|item| names.contains(&item.name))
                .map(|item| item.active_requests)
                .sum::<u64>();

            if active == 0 {
                return DrainStatus {
                    drained: true,
                    remaining_active_requests: 0,
                };
            }

            if Instant::now() >= deadline {
                return DrainStatus {
                    drained: false,
                    remaining_active_requests: active,
                };
            }

            sleep(Duration::from_millis(50)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn registry() -> BackendRegistry {
        let registry = BackendRegistry::default();
        registry
            .replace_service(
                "checkout",
                vec![
                    ("checkout-1".into(), "http://127.0.0.1:12001".into(), true),
                    ("checkout-2".into(), "http://127.0.0.1:12002".into(), true),
                ],
            )
            .await;
        registry
    }

    #[tokio::test]
    async fn draining_backend_accepts_no_new_leases() {
        let registry = registry().await;
        registry
            .mark_draining("checkout", &["checkout-1".to_string()])
            .await;

        for _ in 0..8 {
            let lease = registry.select("checkout").await.unwrap();
            assert_eq!(lease.backend().name(), "checkout-2");
        }

        let snapshots = registry.snapshots("checkout").await;
        assert!(snapshots[0].draining);
        assert!(!snapshots[0].healthy);
    }

    #[tokio::test]
    async fn drainer_waits_for_an_existing_lease() {
        let registry = registry().await;
        let lease = registry.select("checkout").await.unwrap();
        let name = lease.backend().name().to_string();

        registry
            .mark_draining("checkout", std::slice::from_ref(&name))
            .await;

        let timed_out = registry
            .wait_drained(
                "checkout",
                std::slice::from_ref(&name),
                Duration::from_millis(1),
            )
            .await;

        assert!(!timed_out.drained);
        assert_eq!(timed_out.remaining_active_requests, 1);

        drop(lease);

        let drained = registry
            .wait_drained(
                "checkout",
                std::slice::from_ref(&name),
                Duration::from_millis(50),
            )
            .await;

        assert!(drained.drained);
        assert_eq!(drained.remaining_active_requests, 0);
    }

    #[tokio::test]
    async fn cancelled_drain_returns_backend_to_rotation() {
        let registry = registry().await;
        let name = "checkout-1".to_string();

        registry
            .mark_draining("checkout", std::slice::from_ref(&name))
            .await;
        registry
            .cancel_draining("checkout", std::slice::from_ref(&name))
            .await;

        let snapshots = registry.snapshots("checkout").await;
        assert!(snapshots[0].healthy);
        assert!(!snapshots[0].draining);
    }
}
