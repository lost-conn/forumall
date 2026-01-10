/// Authenticated user identity for request handlers.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AuthedUser {
    pub user_id: String,
}

/// Read `Idempotency-Key` from a header map.
pub fn idempotency_key(headers: &dioxus_fullstack::http::HeaderMap) -> Option<String> {
    headers
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
}
