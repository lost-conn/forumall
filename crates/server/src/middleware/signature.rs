//! OFSCP signature verification middleware and extractors.

use axum::{
    extract::{FromRef, FromRequest, FromRequestParts, Request},
    http::{request::Parts, HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use forumall_shared::{
    construct_signature_base, is_local_address, normalize_actor_id, verify_signature,
    OFSCPSignature, PublicKeyDiscoveryResponse, HEADER_ACTOR, HEADER_SIGNATURE, HEADER_TIMESTAMP,
};
use serde::de::DeserializeOwned;

use crate::state::AppState;

/// Verified user identity from OFSCP signature
#[derive(Debug, Clone)]
pub struct SignedRequest {
    pub user_id: String,
    pub key_id: String,
}

/// Optional signed request - returns None instead of error if auth headers missing
#[derive(Debug, Clone)]
pub struct OptionalSignedRequest(pub Option<SignedRequest>);

/// Rejection type for signature verification failures
pub struct SignatureRejection(pub StatusCode, pub String);

impl IntoResponse for SignatureRejection {
    fn into_response(self) -> Response {
        (self.0, self.1).into_response()
    }
}

/// Extractor for requests with OFSCP signature verification and JSON body
pub struct SignedJson<T> {
    pub value: T,
    pub user_id: String,
    pub key_id: String,
}

impl<S, T> FromRequest<S> for SignedJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned + Send,
    AppState: FromRef<S>,
{
    type Rejection = SignatureRejection;

    fn from_request(req: Request, state: &S) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        async move {
            let app_state = AppState::from_ref(state);
            let (parts, body) = req.into_parts();

            let bytes = axum::body::to_bytes(body, usize::MAX)
                .await
                .map_err(|e| SignatureRejection(StatusCode::BAD_REQUEST, format!("Failed to read body: {e}")))?;

            let (user_id, key_id) = verify_ofscp_signature(&app_state, &parts.method, &parts.uri, &parts.headers, &bytes)
                .await
                .map_err(|e| {
                    tracing::error!("Signature verification failed: {:?}", e);
                    SignatureRejection(StatusCode::UNAUTHORIZED, format!("Signature error: {:?}", e))
                })?;

            let value: T = serde_json::from_slice(&bytes)
                .map_err(|e| SignatureRejection(StatusCode::BAD_REQUEST, format!("Invalid JSON: {e}")))?;

            Ok(SignedJson { value, user_id, key_id })
        }
    }
}

/// Extractor for GET requests with OFSCP signature verification (no body)
impl<S> FromRequestParts<S> for SignedRequest
where
    S: Send + Sync,
    AppState: FromRef<S>,
{
    type Rejection = SignatureRejection;

    fn from_request_parts(parts: &mut Parts, state: &S) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        let app_state = AppState::from_ref(state);
        let method = parts.method.clone();
        let uri = parts.uri.clone();
        let headers = parts.headers.clone();

        async move {
            let (user_id, key_id) = verify_ofscp_signature(&app_state, &method, &uri, &headers, &[])
                .await
                .map_err(|e| {
                    tracing::error!("Signature verification failed: {:?}", e);
                    SignatureRejection(StatusCode::UNAUTHORIZED, format!("Signature error: {:?}", e))
                })?;

            Ok(SignedRequest { user_id, key_id })
        }
    }
}

/// Extractor for optional OFSCP signature verification
/// Returns None if auth headers are missing, Some(SignedRequest) if valid
impl<S> FromRequestParts<S> for OptionalSignedRequest
where
    S: Send + Sync,
    AppState: FromRef<S>,
{
    type Rejection = std::convert::Infallible;

    fn from_request_parts(parts: &mut Parts, state: &S) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        let app_state = AppState::from_ref(state);
        let method = parts.method.clone();
        let uri = parts.uri.clone();
        let headers = parts.headers.clone();

        async move {
            // Check if auth headers are present
            if headers.get(HEADER_SIGNATURE).is_none() {
                return Ok(OptionalSignedRequest(None));
            }

            // Try to verify signature
            match verify_ofscp_signature(&app_state, &method, &uri, &headers, &[]).await {
                Ok((user_id, key_id)) => Ok(OptionalSignedRequest(Some(SignedRequest { user_id, key_id }))),
                Err(_) => Ok(OptionalSignedRequest(None)),
            }
        }
    }
}

/// Verify OFSCP signature from request headers
pub async fn verify_ofscp_signature(
    state: &AppState,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<(String, String), String> {
    let sig_header_val = headers
        .get(HEADER_SIGNATURE)
        .ok_or_else(|| format!("Missing {} header", HEADER_SIGNATURE))?
        .to_str()
        .map_err(|_| format!("Invalid {} header format", HEADER_SIGNATURE))?;

    let sig_header = OFSCPSignature::parse(sig_header_val)
        .map_err(|e| format!("Failed to parse signature header: {}", e))?;

    let actor_handle = headers
        .get(HEADER_ACTOR)
        .ok_or_else(|| format!("Missing {} header", HEADER_ACTOR))?
        .to_str()
        .map_err(|_| format!("Invalid {} header format", HEADER_ACTOR))?;

    let timestamp = headers
        .get(HEADER_TIMESTAMP)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    // Fetch public key
    let public_key_str = fetch_public_key(state, actor_handle, &sig_header.key_id)
        .await
        .map_err(|e| format!("Failed to fetch public key for {}: {}", actor_handle, e))?;

    // Reconstruct and verify signature
    let base = construct_signature_base(method.as_str(), uri.path(), timestamp, body);

    verify_signature(&public_key_str, &sig_header.signature, base.as_bytes())?;

    // Return normalized user ID
    let final_id = normalize_actor_id(actor_handle);
    Ok((final_id, sig_header.key_id))
}

/// Verify OFSCP signature from WebSocket query parameters
pub async fn verify_ofscp_signature_from_query(
    state: &AppState,
    uri: &Uri,
) -> Result<(String, String), String> {
    use chrono::{DateTime, TimeDelta, Utc};

    let query = uri.query().ok_or("Missing query string")?;
    let params: std::collections::HashMap<String, String> =
        url::form_urlencoded::parse(query.as_bytes())
            .into_owned()
            .collect();

    let actor = params.get("actor").ok_or("Missing actor parameter")?;
    let timestamp = params.get("timestamp").ok_or("Missing timestamp parameter")?;
    let key_id = params.get("keyId").ok_or("Missing keyId parameter")?;
    let signature = params.get("signature").ok_or("Missing signature parameter")?;

    // Validate timestamp (5 minute window)
    let ts = DateTime::parse_from_rfc3339(timestamp)
        .map_err(|_| "Invalid timestamp format")?;
    let now = Utc::now();
    let diff = now.signed_duration_since(ts.with_timezone(&Utc));
    if diff.abs() > TimeDelta::minutes(5) {
        return Err("Timestamp outside acceptable window".to_string());
    }

    // Fetch public key
    let public_key_str = fetch_public_key(state, actor, key_id).await?;

    // Verify signature (GET, path only, timestamp, empty body hash)
    let base = construct_signature_base("GET", uri.path(), timestamp, &[]);

    verify_signature(&public_key_str, signature, base.as_bytes())?;

    let final_id = normalize_actor_id(actor);
    Ok((final_id, key_id.clone()))
}

/// Fetch public key for an actor, checking local DB first then remote
async fn fetch_public_key(
    state: &AppState,
    actor: &str,
    key_id: &str,
) -> Result<String, String> {
    // Extract handle and domain from actor
    let segments: Vec<&str> = if actor.starts_with('@') {
        actor.split('@').collect()
    } else {
        vec!["", actor, "localhost"]
    };

    if segments.len() < 3 {
        return Err("Invalid actor format".to_string());
    }
    let handle = segments[1];
    let domain = segments[2];

    // Try local DB first
    let keys = state.db
        .query("device_keys")
        .filter(|f| {
            f.eq("key_id", key_id.to_string())
                & f.eq("user_handle", handle.to_string())
                & f.eq("revoked", "false")
        })
        .collect()
        .await
        .map_err(|e| e.to_string())?;

    if let Some(doc) = keys.into_iter().next() {
        return doc
            .data
            .get("public_key")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or("Public key not found in record".to_string());
    }

    // Try remote fetch for cross-origin requests
    let scheme = if is_local_address(domain) { "http" } else { "https" };
    let url = format!("{}://{}/.well-known/ofscp/users/{}/keys", scheme, domain, handle);

    tracing::debug!("Fetching remote public key from: {}", url);

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch remote key: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Remote key fetch failed with status: {}", response.status()));
    }

    let discovery: PublicKeyDiscoveryResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse remote key response: {}", e))?;

    for key in discovery.keys {
        if key.key_id == key_id {
            return Ok(key.public_key);
        }
    }

    Err(format!("Key {} not found for actor {}", key_id, actor))
}

/// Read `Idempotency-Key` header
pub fn idempotency_key(headers: &HeaderMap) -> Option<String> {
    headers
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
}
