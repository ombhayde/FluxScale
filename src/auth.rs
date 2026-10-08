use crate::config::SecurityConfig;
use axum::http::HeaderMap;
use std::{env, io, sync::Arc};

const AUTHORIZATION_HEADER: &str = "authorization";
const MIN_TOKEN_LENGTH: usize = 32;
const MAX_TOKEN_LENGTH: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    Read,
    Ingest,
    Managed,
}

impl Permission {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Ingest => "ingest",
            Self::Managed => "managed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthFailure {
    MissingOrInvalid,
    Forbidden,
}

#[derive(Clone)]
pub struct AuthState {
    enabled: bool,
    public_health: bool,
    read_token: Option<Arc<str>>,
    ingest_token: Option<Arc<str>>,
    managed_token: Option<Arc<str>>,
}

impl AuthState {
    pub fn load(config: &SecurityConfig) -> io::Result<Self> {
        if !config.enabled {
            return Ok(Self {
                enabled: false,
                public_health: config.public_health,
                read_token: None,
                ingest_token: None,
                managed_token: None,
            });
        }

        let read_token = read_token_from_env(&config.read_token_env, Permission::Read)?;
        let ingest_token = read_token_from_env(&config.ingest_token_env, Permission::Ingest)?;
        let managed_token = read_token_from_env(&config.managed_token_env, Permission::Managed)?;

        if constant_time_eq(read_token.as_bytes(), ingest_token.as_bytes())
            || constant_time_eq(read_token.as_bytes(), managed_token.as_bytes())
            || constant_time_eq(ingest_token.as_bytes(), managed_token.as_bytes())
        {
            return Err(invalid(
                "security tokens must contain three different values",
            ));
        }

        Ok(Self {
            enabled: true,
            public_health: config.public_health,
            read_token: Some(Arc::from(read_token)),
            ingest_token: Some(Arc::from(ingest_token)),
            managed_token: Some(Arc::from(managed_token)),
        })
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn public_health(&self) -> bool {
        self.public_health
    }

    pub fn authorize(&self, headers: &HeaderMap, required: Permission) -> Result<(), AuthFailure> {
        if !self.enabled {
            return Ok(());
        }

        let supplied = bearer_token(headers).ok_or(AuthFailure::MissingOrInvalid)?;

        let matched = self.permission_for_token(supplied);

        match matched {
            Some(permission) if permission == required => Ok(()),
            Some(_) => Err(AuthFailure::Forbidden),
            None => Err(AuthFailure::MissingOrInvalid),
        }
    }

    fn permission_for_token(&self, supplied: &str) -> Option<Permission> {
        let candidates = [
            (Permission::Read, self.read_token.as_deref()),
            (Permission::Ingest, self.ingest_token.as_deref()),
            (Permission::Managed, self.managed_token.as_deref()),
        ];

        let mut matched = None;

        for (permission, candidate) in candidates {
            if let Some(candidate) = candidate {
                if constant_time_eq(supplied.as_bytes(), candidate.as_bytes()) {
                    matched = Some(permission);
                }
            }
        }

        matched
    }

    #[cfg(test)]
    fn for_test(read: &str, ingest: &str, managed: &str) -> Self {
        Self {
            enabled: true,
            public_health: true,
            read_token: Some(Arc::from(read)),
            ingest_token: Some(Arc::from(ingest)),
            managed_token: Some(Arc::from(managed)),
        }
    }
}

fn read_token_from_env(variable: &str, permission: Permission) -> io::Result<String> {
    let value = env::var(variable).map_err(|_| {
        invalid(&format!(
            "security is enabled but {variable} is missing for the {} permission",
            permission.as_str()
        ))
    })?;

    if value.len() < MIN_TOKEN_LENGTH || value.len() > MAX_TOKEN_LENGTH {
        return Err(invalid(&format!(
            "{variable} must contain between {MIN_TOKEN_LENGTH} and {MAX_TOKEN_LENGTH} characters"
        )));
    }

    if value.chars().any(char::is_whitespace) || value.chars().any(char::is_control) {
        return Err(invalid(&format!(
            "{variable} cannot contain whitespace or control characters"
        )));
    }

    Ok(value)
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let mut values = headers.get_all(AUTHORIZATION_HEADER).iter();
    let value = values.next()?;

    if values.next().is_some() {
        return None;
    }

    let raw = value.to_str().ok()?;
    let (scheme, token) = raw.split_once(' ')?;

    if !scheme.eq_ignore_ascii_case("Bearer")
        || token.is_empty()
        || token.chars().any(char::is_whitespace)
    {
        return None;
    }

    Some(token)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let maximum = left.len().max(right.len());
    let mut difference = left.len() ^ right.len();

    for index in 0..maximum {
        let left_byte = left.get(index).copied().unwrap_or(0);
        let right_byte = right.get(index).copied().unwrap_or(0);
        difference |= usize::from(left_byte ^ right_byte);
    }

    difference == 0
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderName, HeaderValue};

    const READ: &str = "read-token-00000000000000000000000000000000";
    const INGEST: &str = "ingest-token-000000000000000000000000000000";
    const MANAGED: &str = "managed-token-00000000000000000000000000000";

    fn bearer(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION_HEADER, HeaderValue::from_str(value).unwrap());
        headers
    }

    #[test]
    fn disabled_security_allows_legacy_requests() {
        let auth = AuthState {
            enabled: false,
            public_health: true,
            read_token: None,
            ingest_token: None,
            managed_token: None,
        };

        assert_eq!(
            auth.authorize(&HeaderMap::new(), Permission::Managed),
            Ok(())
        );
    }

    #[test]
    fn exact_permission_is_required() {
        let auth = AuthState::for_test(READ, INGEST, MANAGED);

        assert_eq!(
            auth.authorize(&bearer(&format!("Bearer {READ}")), Permission::Read),
            Ok(())
        );
        assert_eq!(
            auth.authorize(&bearer(&format!("Bearer {INGEST}")), Permission::Read),
            Err(AuthFailure::Forbidden)
        );
        assert_eq!(
            auth.authorize(&bearer("Bearer invalid-token"), Permission::Read),
            Err(AuthFailure::MissingOrInvalid)
        );
    }

    #[test]
    fn malformed_or_duplicate_authorization_is_rejected() {
        let auth = AuthState::for_test(READ, INGEST, MANAGED);

        assert_eq!(
            auth.authorize(&bearer(READ), Permission::Read),
            Err(AuthFailure::MissingOrInvalid)
        );

        let mut headers = bearer(&format!("Bearer {READ}"));
        headers.append(
            HeaderName::from_static(AUTHORIZATION_HEADER),
            HeaderValue::from_static("Bearer second-token"),
        );

        assert_eq!(
            auth.authorize(&headers, Permission::Read),
            Err(AuthFailure::MissingOrInvalid)
        );
    }

    #[test]
    fn comparison_handles_different_lengths() {
        assert!(constant_time_eq(b"same", b"same"));
        assert!(!constant_time_eq(b"same", b"same-longer"));
        assert!(!constant_time_eq(b"same", b"diff"));
    }
}
