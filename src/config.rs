use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, io, path::Path};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub server: ServerConfig,
    pub proxy: ProxyConfig,
    pub ingestion: IngestionConfig,
    pub docker: DockerConfig,
    pub scaling: ScalingConfig,
    pub security: SecurityConfig,
    pub operations: OperationsConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    pub bind: String,
    pub dashboard_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ProxyConfig {
    pub bind: String,
    pub max_body_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct IngestionConfig {
    pub max_past_age_seconds: i64,
    pub max_future_skew_seconds: i64,
    pub instance_stale_after_seconds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DockerConfig {
    pub enabled: bool,
    pub image: String,
    pub container_port: u16,
    pub host_port_base: u16,
    pub port_block_size: u16,
    pub name_prefix: String,
    pub health_timeout_seconds: u64,
    pub drain_timeout_seconds: u64,
    pub supervision_enabled: bool,
    pub supervision_interval_seconds: u64,
    pub unhealthy_threshold: u32,
    pub telemetry_endpoint: Option<String>,
    pub environment: Vec<String>,
    pub cpus: Option<f64>,
    pub memory_mb: Option<u64>,
    pub network: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ScalingConfig {
    pub min_replicas: u32,
    pub max_replicas: u32,
    pub prediction_horizon_seconds: i64,
    pub history_limit: usize,
    pub scale_up_cooldown_seconds: i64,
    pub scale_down_cooldown_seconds: i64,
    pub scale_down_utilization: f64,
    pub target_p95_latency_ms: f64,
    pub max_error_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SecurityConfig {
    pub enabled: bool,
    pub public_health: bool,
    pub read_token_env: String,
    pub ingest_token_env: String,
    pub managed_token_env: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct OperationsConfig {
    pub rate_limiting_enabled: bool,
    pub audit_capacity: usize,
    pub health_requests_per_minute: u32,
    pub read_requests_per_minute: u32,
    pub ingest_requests_per_minute: u32,
    pub audit_requests_per_minute: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server: ServerConfig::default(),
            proxy: ProxyConfig::default(),
            ingestion: IngestionConfig::default(),
            docker: DockerConfig::default(),
            scaling: ScalingConfig::default(),
            security: SecurityConfig::default(),
            operations: OperationsConfig::default(),
        }
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1:8080".to_string(),
            dashboard_path: None,
        }
    }
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1:8081".to_string(),
            max_body_bytes: 1_048_576,
        }
    }
}

impl Default for IngestionConfig {
    fn default() -> Self {
        Self {
            max_past_age_seconds: 15 * 60,
            max_future_skew_seconds: 30,
            instance_stale_after_seconds: 10,
        }
    }
}

impl Default for DockerConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            image: "fluxscale/demo-service:phase2".to_string(),
            container_port: 3000,
            host_port_base: 12_000,
            port_block_size: 25,
            name_prefix: "fluxscale".to_string(),
            health_timeout_seconds: 15,
            drain_timeout_seconds: 5,
            supervision_enabled: false,
            supervision_interval_seconds: 5,
            unhealthy_threshold: 3,
            telemetry_endpoint: None,
            environment: Vec::new(),
            cpus: None,
            memory_mb: None,
            network: None,
        }
    }
}

impl Default for ScalingConfig {
    fn default() -> Self {
        Self {
            min_replicas: 1,
            max_replicas: 20,
            prediction_horizon_seconds: 10,
            history_limit: 120,
            scale_up_cooldown_seconds: 5,
            scale_down_cooldown_seconds: 60,
            scale_down_utilization: 0.45,
            target_p95_latency_ms: 500.0,
            max_error_rate: 0.05,
        }
    }
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            public_health: true,
            read_token_env: "FLUXSCALE_READ_TOKEN".to_string(),
            ingest_token_env: "FLUXSCALE_INGEST_TOKEN".to_string(),
            managed_token_env: "FLUXSCALE_MANAGED_TOKEN".to_string(),
        }
    }
}

impl Default for OperationsConfig {
    fn default() -> Self {
        Self {
            rate_limiting_enabled: true,
            audit_capacity: 2_000,
            health_requests_per_minute: 600,
            read_requests_per_minute: 1_200,
            ingest_requests_per_minute: 12_000,
            audit_requests_per_minute: 120,
        }
    }
}

impl Config {
    pub fn load(path: impl AsRef<Path>) -> Result<Self, Box<dyn std::error::Error>> {
        let path = path.as_ref();

        if !path.exists() {
            let config = Self::default();
            config.validate()?;
            return Ok(config);
        }

        let raw = fs::read_to_string(path)?;
        let config: Self = toml::from_str(&raw)?;
        config.validate()?;

        Ok(config)
    }

    pub fn validate(&self) -> Result<(), io::Error> {
        if self
            .docker
            .environment
            .iter()
            .any(|name| !valid_environment_name(name))
        {
            return Err(invalid(
                "docker.environment must contain environment variable names only",
            ));
        }
        if self.docker.environment.iter().any(|name| {
            matches!(
                name.as_str(),
                "INSTANCE_ID"
                    | "FLUXSCALE_INSTANCE_ID"
                    | "FLUXSCALE_SERVICE"
                    | "FLUXSCALE_ENDPOINT"
                    | "PORT"
            )
        }) {
            return Err(invalid(
                "docker.environment cannot override managed service identity, port or endpoint",
            ));
        }
        if self
            .docker
            .cpus
            .is_some_and(|value| !value.is_finite() || value <= 0.0)
            || self.docker.memory_mb.is_some_and(|value| value < 16)
        {
            return Err(invalid(
                "Docker CPU limit must be positive and memory limit at least 16 MiB",
            ));
        }
        if let Some(network) = &self.docker.network {
            if network.is_empty()
                || network.len() > 128
                || !network
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
            {
                return Err(invalid("Docker network must contain 1-128 letters, numbers, dots, underscores or hyphens"));
            }
        }
        if let Some(endpoint) = &self.docker.telemetry_endpoint {
            let url = reqwest::Url::parse(endpoint)
                .map_err(|_| invalid("invalid Docker telemetry endpoint"))?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(invalid("Docker telemetry endpoint must be an HTTP URL without credentials, query or fragment"));
            }
        }
        let scaling = &self.scaling;

        if scaling.min_replicas == 0 || scaling.min_replicas > scaling.max_replicas {
            return Err(invalid("min_replicas must be between 1 and max_replicas"));
        }

        if scaling.prediction_horizon_seconds <= 0 {
            return Err(invalid("prediction_horizon_seconds must be positive"));
        }

        if scaling.history_limit < 3 {
            return Err(invalid("history_limit must be at least 3"));
        }

        if scaling.scale_up_cooldown_seconds < 0 || scaling.scale_down_cooldown_seconds < 0 {
            return Err(invalid("scaling cooldowns cannot be negative"));
        }

        if !(0.0..=1.0).contains(&scaling.scale_down_utilization) {
            return Err(invalid("scale_down_utilization must be between 0 and 1"));
        }

        if scaling.target_p95_latency_ms <= 0.0 || !scaling.target_p95_latency_ms.is_finite() {
            return Err(invalid("target_p95_latency_ms must be positive"));
        }

        if !(0.0..=1.0).contains(&scaling.max_error_rate) {
            return Err(invalid("max_error_rate must be between 0 and 1"));
        }

        if self.proxy.max_body_bytes == 0 {
            return Err(invalid("proxy.max_body_bytes must be positive"));
        }

        if !(1..=24 * 60 * 60).contains(&self.ingestion.max_past_age_seconds) {
            return Err(invalid(
                "ingestion.max_past_age_seconds must be between 1 and 86400",
            ));
        }

        if !(0..=60 * 60).contains(&self.ingestion.max_future_skew_seconds) {
            return Err(invalid(
                "ingestion.max_future_skew_seconds must be between 0 and 3600",
            ));
        }

        if !(2..=300).contains(&self.ingestion.instance_stale_after_seconds) {
            return Err(invalid(
                "ingestion.instance_stale_after_seconds must be between 2 and 300",
            ));
        }

        if (self.docker.port_block_size as u32) < scaling.max_replicas {
            return Err(invalid("docker.port_block_size must cover max_replicas"));
        }

        if !(1..=300).contains(&self.docker.supervision_interval_seconds) {
            return Err(invalid(
                "docker.supervision_interval_seconds must be between 1 and 300",
            ));
        }

        if !(1..=20).contains(&self.docker.unhealthy_threshold) {
            return Err(invalid(
                "docker.unhealthy_threshold must be between 1 and 20",
            ));
        }

        let highest_port = self.docker.host_port_base as u32
            + 999 * self.docker.port_block_size as u32
            + scaling.max_replicas;

        if highest_port > u16::MAX as u32 {
            return Err(invalid("Docker port range exceeds 65535"));
        }

        if self.security.enabled {
            let names = [
                self.security.read_token_env.trim(),
                self.security.ingest_token_env.trim(),
                self.security.managed_token_env.trim(),
            ];

            if names.iter().any(|name| !valid_environment_name(name)) {
                return Err(invalid(
                    "security token environment names must use letters, numbers and underscores",
                ));
            }

            let unique: HashSet<_> = names.into_iter().collect();

            if unique.len() != 3 {
                return Err(invalid(
                    "security token environment names must be different",
                ));
            }
        }

        if !(100..=100_000).contains(&self.operations.audit_capacity) {
            return Err(invalid(
                "operations.audit_capacity must be between 100 and 100000",
            ));
        }

        for (name, limit) in [
            (
                "operations.health_requests_per_minute",
                self.operations.health_requests_per_minute,
            ),
            (
                "operations.read_requests_per_minute",
                self.operations.read_requests_per_minute,
            ),
            (
                "operations.ingest_requests_per_minute",
                self.operations.ingest_requests_per_minute,
            ),
            (
                "operations.audit_requests_per_minute",
                self.operations.audit_requests_per_minute,
            ),
        ] {
            if !(1..=1_000_000).contains(&limit) {
                return Err(invalid(&format!("{name} must be between 1 and 1000000")));
            }
        }

        Ok(())
    }
}

fn valid_environment_name(value: &str) -> bool {
    let mut characters = value.chars();

    matches!(characters.next(), Some(first) if first == '_' || first.is_ascii_alphabetic())
        && characters.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_local_profile_is_secure_and_bounded() {
        let config: Config = toml::from_str(include_str!("../fluxscale.local.toml")).unwrap();
        config.validate().unwrap();
        assert!(config.security.enabled && config.docker.supervision_enabled);
        assert_eq!(config.scaling.max_replicas, 3);
        assert_eq!(config.docker.environment, vec!["FLUXSCALE_MANAGED_TOKEN"]);
        assert!(config.server.dashboard_path.is_some());
    }

    #[test]
    fn docker_network_rejects_unsafe_names() {
        let mut config = Config::default();
        for network in ["", "../other", "net work"] {
            config.docker.network = Some(network.into());
            assert!(config.validate().is_err());
        }
        config.docker.network = Some("fluxscale-app".into());
        config.validate().unwrap();
    }

    #[test]
    fn managed_container_configuration_validates_resources_and_secrets() {
        let mut config = Config::default();
        config.docker.telemetry_endpoint = Some("http://host.docker.internal:8080".into());
        config.docker.environment = vec!["FLUXSCALE_MANAGED_TOKEN".into()];
        config.docker.cpus = Some(1.0);
        config.docker.memory_mb = Some(256);
        assert!(config.validate().is_ok());
        config.docker.environment = vec!["TOKEN=secret".into()];
        assert!(config.validate().is_err());
        config.docker.environment.clear();
        config.docker.environment = vec!["FLUXSCALE_INSTANCE_ID".into()];
        assert!(config.validate().is_err());
        config.docker.environment.clear();
        config.docker.cpus = Some(f64::NAN);
        assert!(config.validate().is_err());
        config.docker.cpus = None;
        config.docker.memory_mb = Some(0);
        assert!(config.validate().is_err());
        config.docker.memory_mb = None;
        config.docker.telemetry_endpoint = Some("http://user:secret@localhost:8080".into());
        assert!(config.validate().is_err());
    }

    #[test]
    fn default_scaling_does_not_require_capacity_input() {
        let config = ScalingConfig::default();

        assert_eq!(config.min_replicas, 1);
        assert_eq!(config.max_replicas, 20);
    }

    #[test]
    fn old_capacity_fields_are_ignored_for_compatibility() {
        let raw = r#"
            [scaling]
            min_replicas = 1
            max_replicas = 10
            target_rps_per_replica = 800.0
            target_utilization = 0.80
            prediction_horizon_seconds = 10
            history_limit = 120
            scale_up_cooldown_seconds = 5
            scale_down_cooldown_seconds = 60
            scale_down_utilization = 0.45
            target_p95_latency_ms = 500.0
            max_error_rate = 0.05
        "#;

        let config: Config = toml::from_str(raw).unwrap();

        assert_eq!(config.scaling.max_replicas, 10);
        assert!(!config.security.enabled);
    }

    #[test]
    fn security_is_backward_compatible_but_explicitly_enableable() {
        let default_config = Config::default();

        assert!(!default_config.security.enabled);
        assert!(default_config.security.public_health);

        let raw = r#"
            [security]
            enabled = true
            public_health = false
            read_token_env = "READ_SECRET"
            ingest_token_env = "INGEST_SECRET"
            managed_token_env = "MANAGED_SECRET"
        "#;

        let config: Config = toml::from_str(raw).unwrap();
        config.validate().unwrap();

        assert!(config.security.enabled);
        assert!(!config.security.public_health);
    }

    #[test]
    fn enabled_security_requires_distinct_environment_names() {
        let mut config = Config::default();
        config.security.enabled = true;
        config.security.ingest_token_env = config.security.read_token_env.clone();

        assert!(config.validate().is_err());
    }

    #[test]
    fn ingestion_integrity_defaults_are_backward_compatible() {
        let config: Config = toml::from_str("[server]\nbind = '127.0.0.1:8080'").unwrap();

        assert_eq!(config.ingestion.max_past_age_seconds, 900);
        assert_eq!(config.ingestion.max_future_skew_seconds, 30);
        assert_eq!(config.ingestion.instance_stale_after_seconds, 10);
        config.validate().unwrap();
    }

    #[test]
    fn ingestion_integrity_rejects_unsafe_time_windows() {
        let mut config = Config::default();
        config.ingestion.max_past_age_seconds = 0;
        assert!(config.validate().is_err());

        config.ingestion.max_past_age_seconds = 900;
        config.ingestion.max_future_skew_seconds = 3_601;
        assert!(config.validate().is_err());

        config.ingestion.max_future_skew_seconds = 30;
        config.ingestion.instance_stale_after_seconds = 1;
        assert!(config.validate().is_err());
    }

    #[test]
    fn docker_supervision_is_safe_and_opt_in_by_default() {
        let config = DockerConfig::default();

        assert!(!config.supervision_enabled);
        assert_eq!(config.supervision_interval_seconds, 5);
        assert_eq!(config.unhealthy_threshold, 3);
    }

    #[test]
    fn docker_supervision_rejects_unsafe_limits() {
        let mut config = Config::default();
        config.docker.supervision_interval_seconds = 0;
        assert!(config.validate().is_err());

        config.docker.supervision_interval_seconds = 5;
        config.docker.unhealthy_threshold = 0;
        assert!(config.validate().is_err());
    }

    #[test]
    fn operational_protection_has_safe_defaults() {
        let config = OperationsConfig::default();

        assert!(config.rate_limiting_enabled);
        assert_eq!(config.audit_capacity, 2_000);
        assert!(config.ingest_requests_per_minute > config.read_requests_per_minute);
    }

    #[test]
    fn operational_protection_rejects_unsafe_limits() {
        let mut config = Config::default();
        config.operations.audit_capacity = 99;
        assert!(config.validate().is_err());

        config.operations.audit_capacity = 2_000;
        config.operations.read_requests_per_minute = 0;
        assert!(config.validate().is_err());
    }
}
