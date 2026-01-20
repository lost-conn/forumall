//! Shared error types including RFC7807 Problem Details.

use serde::{Deserialize, Serialize};

/// RFC7807 Problem Details (application/problem+json)
///
/// We use this as our canonical error envelope for `/api/*` endpoints so clients
/// can surface meaningful auth and validation errors instead of failing to decode
/// a success response type.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProblemDetails {
    /// A URI reference that identifies the problem type.
    #[serde(rename = "type")]
    pub type_url: String,
    /// A short, human-readable summary of the problem type.
    pub title: String,
    /// HTTP status code.
    pub status: u16,
    /// Human-readable explanation specific to this occurrence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// A URI reference that identifies the specific occurrence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
}

impl ProblemDetails {
    pub fn bad_request(detail: impl Into<String>) -> Self {
        Self {
            type_url: "https://ofscp.dev/problems/bad-request".to_string(),
            title: "Bad Request".to_string(),
            status: 400,
            detail: Some(detail.into()),
            instance: None,
        }
    }

    pub fn unauthorized(detail: impl Into<String>) -> Self {
        Self {
            type_url: "https://ofscp.dev/problems/unauthorized".to_string(),
            title: "Unauthorized".to_string(),
            status: 401,
            detail: Some(detail.into()),
            instance: None,
        }
    }

    pub fn forbidden(detail: impl Into<String>) -> Self {
        Self {
            type_url: "https://ofscp.dev/problems/forbidden".to_string(),
            title: "Forbidden".to_string(),
            status: 403,
            detail: Some(detail.into()),
            instance: None,
        }
    }

    pub fn not_found(detail: impl Into<String>) -> Self {
        Self {
            type_url: "https://ofscp.dev/problems/not-found".to_string(),
            title: "Not Found".to_string(),
            status: 404,
            detail: Some(detail.into()),
            instance: None,
        }
    }

    pub fn conflict(detail: impl Into<String>) -> Self {
        Self {
            type_url: "https://ofscp.dev/problems/conflict".to_string(),
            title: "Conflict".to_string(),
            status: 409,
            detail: Some(detail.into()),
            instance: None,
        }
    }

    pub fn internal_error(detail: impl Into<String>) -> Self {
        Self {
            type_url: "https://ofscp.dev/problems/internal-error".to_string(),
            title: "Internal Server Error".to_string(),
            status: 500,
            detail: Some(detail.into()),
            instance: None,
        }
    }
}

/// Attempt to parse an RFC7807 (or RFC7807-ish) JSON body into a user-facing message.
/// Prefers `detail`, falls back to `title`.
pub fn try_problem_detail(body: &str) -> Option<String> {
    let parsed = serde_json::from_str::<ProblemDetails>(body).ok()?;
    if let Some(detail) = parsed.detail {
        if !detail.trim().is_empty() {
            return Some(detail);
        }
    }
    if !parsed.title.trim().is_empty() {
        return Some(parsed.title);
    }
    None
}

/// API error type for client-side use
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiError {
    Network(String),
    Http { status: u16, body: String },
    Deserialize(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Network(msg) => write!(f, "Network error: {}", msg),
            ApiError::Http { status, body } => write!(f, "HTTP {}: {}", status, body),
            ApiError::Deserialize(msg) => write!(f, "Deserialization error: {}", msg),
        }
    }
}

impl std::error::Error for ApiError {}
