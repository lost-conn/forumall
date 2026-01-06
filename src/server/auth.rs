
use dioxus_fullstack::{HttpError, StatusCode};
use dioxus::prelude::*;
use dioxus::logger::tracing;
use crate::problem::{problem_http_error, ProblemDetails};

/// Authenticated user identity for request handlers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthedUser {
    pub user_id: String,
}

/// Extract and validate `Authorization: Bearer <token>`.
///
/// This is a minimal dev stand-in for OAuth2 token validation (OFSCP spec 4.2).
pub fn require_bearer_user_id(headers: &dioxus_fullstack::http::HeaderMap) -> Result<AuthedUser, HttpError> {
    let authz = headers
        .get(dioxus_fullstack::http::header::AUTHORIZATION)
        .or_else(|| {
            headers.iter().find(|(k, _)| k.as_str().to_lowercase() == "authorization").map(|(_, v)| v)
        })
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| {
            tracing::error!("Auth Error: Missing Authorization header");
            let p = ProblemDetails::unauthorized("Missing Authorization header");
            problem_http_error(&p, StatusCode::UNAUTHORIZED)
        })?;

    let token = authz
        .strip_prefix("Bearer ")
        .ok_or_else(|| {
            let p = ProblemDetails::unauthorized("Expected Bearer token");
            problem_http_error(&p, StatusCode::UNAUTHORIZED)
        })?
        .trim();

    if token.is_empty() {
        let p = ProblemDetails::unauthorized("Empty Bearer token");
        return Err(problem_http_error(&p, StatusCode::UNAUTHORIZED));
    }

    validate_token(token)
}

/// Validate a raw access token string.
pub fn validate_token(token: &str) -> Result<AuthedUser, HttpError> {
    #[cfg(feature = "server")]
    {
        let claims = crate::server::jwt::validate_access_token(token).map_err(|e| {
            tracing::error!("Auth Error: invalid jwt: {e:?}");
            let p = ProblemDetails::unauthorized("Invalid token");
            problem_http_error(&p, StatusCode::UNAUTHORIZED)
        })?;

        Ok(AuthedUser {
            user_id: claims.sub,
        })
    }

    #[cfg(not(feature = "server"))]
    {
        let _ = token;
        Ok(AuthedUser {
            user_id: "dev-user".to_string(),
        })
    }
}

/// Read `Idempotency-Key` from a header map.
pub fn idempotency_key(headers: &dioxus_fullstack::http::HeaderMap) -> Option<String> {
    headers
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
}



#[dioxus_fullstack::post("/api/auth/logout")]
pub async fn logout() -> Result<(), ServerFnError> {
    #[cfg(feature = "server")]
    {
        // With stateless JWT access tokens, logout is handled client-side by dropping the token.
        // (Future: implement refresh token revocation.)
        Ok(())
    }
    #[cfg(not(feature = "server"))]
    Ok(())
}
