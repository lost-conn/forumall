use dioxus_fullstack::{HttpError, StatusCode};
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
    pub fn unauthorized(detail: impl Into<String>) -> Self {
        Self {
            type_url: "https://ofscp.dev/problems/unauthorized".to_string(),
            title: "Unauthorized".to_string(),
            status: StatusCode::UNAUTHORIZED.as_u16(),
            detail: Some(detail.into()),
            instance: None,
        }
    }

    pub fn forbidden(detail: impl Into<String>) -> Self {
        Self {
            type_url: "https://ofscp.dev/problems/forbidden".to_string(),
            title: "Forbidden".to_string(),
            status: StatusCode::FORBIDDEN.as_u16(),
            detail: Some(detail.into()),
            instance: None,
        }
    }
}

/// Convert an RFC7807 problem into a Dioxus HttpError.
///
/// NOTE: Dioxus Fullstack server-fn transport doesn't currently expose full
/// control over response content-type, but we still embed the problem JSON into
/// the error message so clients can parse/display it.
pub fn problem_http_error(problem: &ProblemDetails, status: StatusCode) -> HttpError {
    let msg = serde_json::to_string(problem).unwrap_or_else(|_| problem.title.clone());
    HttpError::new(status, msg)
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

