use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct SignedJson<T> {
    pub value: T,
    pub user_id: String,
    pub key_id: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct OFSCPSignature {
    pub key_id: String,
    pub signature: String,
}

impl OFSCPSignature {
    pub fn parse(header: &str) -> Result<Self, String> {
        let mut key_id = None;
        let mut signature = None;

        for part in header.split(',') {
            let part = part.trim();
            if let Some(rest) = part.strip_prefix("keyId=\"") {
                key_id = Some(rest.trim_end_matches('"').to_string());
            } else if let Some(rest) = part.strip_prefix("signature=\"") {
                signature = Some(rest.trim_end_matches('"').to_string());
            }
        }

        Ok(Self {
            key_id: key_id.ok_or("Missing keyId in signature header")?,
            signature: signature.ok_or("Missing signature in signature header")?,
        })
    }
}

#[cfg(feature = "server")]
use {
    axum::{
        async_trait,
        extract::{FromRequest, Request},
        http::{HeaderMap, Method, StatusCode, Uri},
        response::{IntoResponse, Response},
    },
    dioxus::logger::tracing,
};

#[cfg(feature = "server")]
pub async fn verify_ofscp_signature(
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<(String, String), String> {
    let sig_header_val = headers
        .get("X-OFSCP-Signature")
        .ok_or_else(|| "Missing X-OFSCP-Signature header".to_string())?
        .to_str()
        .map_err(|_| "Invalid X-OFSCP-Signature header format".to_string())?;

    let sig_header = OFSCPSignature::parse(sig_header_val)
        .map_err(|e| format!("Failed to parse signature header: {}", e))?;

    let actor_handle = headers
        .get("X-OFSCP-Actor")
        .ok_or_else(|| "Missing X-OFSCP-Actor header".to_string())?
        .to_str()
        .map_err(|_| "Invalid X-OFSCP-Actor header format".to_string())?;

    // 1. Fetch public key
    let public_key_str = fetch_public_key(actor_handle, &sig_header.key_id)
        .await
        .map_err(|e| format!("Failed to fetch public key for {}: {}", actor_handle, e))?;

    // 2. Reconstruct signature base
    let base = reconstruct_signature_base(method, uri, headers, body);

    // 3. Verify signature
    let decoded_sig = BASE64
        .decode(&sig_header.signature)
        .map_err(|_| "Invalid base64 signature".to_string())?;
    let decoded_pubkey = BASE64
        .decode(&public_key_str)
        .map_err(|_| "Invalid base64 public key".to_string())?;

    let public_key = ed25519_dalek::VerifyingKey::from_bytes(
        &decoded_pubkey
            .try_into()
            .map_err(|_| "Invalid public key length".to_string())?,
    )
    .map_err(|_| "Invalid public key".to_string())?;

    let signature = ed25519_dalek::Signature::from_bytes(
        &decoded_sig
            .try_into()
            .map_err(|_| "Invalid signature length".to_string())?,
    );

    use ed25519_dalek::Verifier;
    public_key
        .verify(base.as_bytes(), &signature)
        .map_err(|e| format!("Signature verification failed: {}", e))?;

    // 4. Return just the handle (without @handle@domain format)
    let final_id = if actor_handle.starts_with('@') {
        let segments: Vec<&str> = actor_handle.split('@').collect();
        if segments.len() >= 2 {
            segments[1].to_string()
        } else {
            actor_handle.to_string()
        }
    } else {
        actor_handle.to_string()
    };

    Ok((final_id, sig_header.key_id))
}

/// Verify OFSCP signature from WebSocket query parameters
/// Used for WebSocket upgrade requests where headers can't be sent from browsers
#[cfg(feature = "server")]
pub async fn verify_ofscp_signature_from_query(uri: &Uri) -> Result<(String, String), String> {
    use chrono::{DateTime, Duration, Utc};

    // 1. Parse query parameters
    let query = uri.query().ok_or("Missing query string")?;
    let params: std::collections::HashMap<String, String> =
        url::form_urlencoded::parse(query.as_bytes())
            .into_owned()
            .collect();

    let actor = params
        .get("actor")
        .ok_or("Missing actor parameter")?;
    let timestamp = params
        .get("timestamp")
        .ok_or("Missing timestamp parameter")?;
    let key_id = params
        .get("keyId")
        .ok_or("Missing keyId parameter")?;
    let signature = params
        .get("signature")
        .ok_or("Missing signature parameter")?;

    // 2. Validate timestamp (5 minute window to prevent replay attacks)
    let ts = DateTime::parse_from_rfc3339(timestamp)
        .map_err(|_| "Invalid timestamp format")?;
    let now = Utc::now();
    let diff = now.signed_duration_since(ts.with_timezone(&Utc));
    if diff.abs() > Duration::minutes(5) {
        return Err("Timestamp outside acceptable window".to_string());
    }

    // 3. Fetch public key
    let public_key_str = fetch_public_key(actor, key_id).await?;

    // 4. Reconstruct signature base (GET, path only, timestamp, empty body hash)
    let path = uri.path();
    let body_hash = hex::encode(Sha256::digest(&[]));
    let base = format!("GET\n{}\n{}\n{}", path, timestamp, body_hash);

    // 5. Verify signature
    let decoded_sig = BASE64
        .decode(signature)
        .map_err(|_| "Invalid base64 signature")?;
    let decoded_pubkey = BASE64
        .decode(&public_key_str)
        .map_err(|_| "Invalid base64 public key")?;

    let public_key = ed25519_dalek::VerifyingKey::from_bytes(
        &decoded_pubkey
            .try_into()
            .map_err(|_| "Invalid public key length")?,
    )
    .map_err(|_| "Invalid public key")?;

    let sig = ed25519_dalek::Signature::from_bytes(
        &decoded_sig
            .try_into()
            .map_err(|_| "Invalid signature length")?,
    );

    use ed25519_dalek::Verifier;
    public_key
        .verify(base.as_bytes(), &sig)
        .map_err(|e| format!("Signature verification failed: {}", e))?;

    // 6. Normalize actor ID and return
    let final_id = normalize_actor_id(actor);
    Ok((final_id, key_id.clone()))
}

#[cfg(feature = "server")]
fn normalize_actor_id(actor: &str) -> String {
    // Always return just the handle, stripping @handle@domain format
    if actor.starts_with('@') {
        let segments: Vec<&str> = actor.split('@').collect();
        if segments.len() >= 2 {
            return segments[1].to_string();
        }
    }
    actor.to_string()
}

#[cfg(feature = "server")]
pub fn reconstruct_signature_base(
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    body: &[u8],
) -> String {
    let timestamp = headers
        .get("X-OFSCP-Timestamp")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let body_hash = hex::encode(Sha256::digest(body));
    format!(
        "{}\n{}\n{}\n{}",
        method.as_str(),
        uri.path(),
        timestamp,
        body_hash
    )
}

#[cfg(feature = "server")]
fn is_local_address(host: &str) -> bool {
    let host_part = host.split(':').next().unwrap_or(host);
    host_part == "localhost"
        || host_part == "127.0.0.1"
        || host_part == "0.0.0.0"
        || host_part.starts_with("192.168.")
        || host_part.starts_with("10.")
}

#[cfg(feature = "server")]
pub async fn fetch_public_key(actor: &str, key_id: &str) -> Result<String, String> {
    // 1. Extract handle and domain
    let segments: Vec<&str> = if actor.starts_with('@') {
        actor.split('@').collect()
    } else {
        vec!["", actor, "localhost"] // Fallback for testing/local
    };

    if segments.len() < 3 {
        return Err("Invalid actor format".to_string());
    }
    let handle = segments[1];
    let domain = segments[2];

    // 2. Try local DB first (covers same-origin requests)
    let db = &*crate::DB;
    let keys = db
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

    // 3. If not found locally, try remote fetch (for cross-origin requests)
    // Use HTTP for local addresses, HTTPS otherwise
    let scheme = if is_local_address(domain) { "http" } else { "https" };
    let url = format!(
        "{}://{}/.well-known/ofscp/users/{}/keys",
        scheme, domain, handle
    );

    tracing::debug!("Fetching remote public key from: {}", url);

    // 4. Make HTTP request
    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch remote key: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Remote key fetch failed with status: {}",
            response.status()
        ));
    }

    // 5. Parse response
    let discovery: crate::device_keys::PublicKeyDiscoveryResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse remote key response: {}", e))?;

    // 6. Find the matching key
    for key in discovery.keys {
        if key.key_id == key_id {
            return Ok(key.public_key);
        }
    }

    Err(format!("Key {} not found for actor {}", key_id, actor))
}

#[cfg(feature = "server")]
#[async_trait]
impl<T, S> FromRequest<S> for SignedJson<T>
where
    T: DeserializeOwned + Send,
    S: Send + Sync,
{
    type Rejection = SignatureRejection;

    async fn from_request(req: Request, _state: &S) -> Result<Self, Self::Rejection> {
        let (parts, body) = req.into_parts();
        let bytes = axum::body::to_bytes(body, usize::MAX).await.map_err(|e| {
            SignatureRejection(StatusCode::BAD_REQUEST, format!("Failed to read body: {e}"))
        })?;

        let (user_id, key_id) =
            verify_ofscp_signature(&parts.method, &parts.uri, &parts.headers, &bytes)
                .await
                .map_err(|e| {
                    tracing::error!("Signature verification failed: {:?}", e);
                    SignatureRejection(
                        StatusCode::UNAUTHORIZED,
                        format!("Signature error: {:?}", e),
                    )
                })?;

        let value: T = serde_json::from_slice(&bytes).map_err(|e| {
            SignatureRejection(StatusCode::BAD_REQUEST, format!("Invalid JSON: {e}"))
        })?;

        Ok(SignedJson {
            value,
            user_id,
            key_id,
        })
    }
}

#[cfg(feature = "server")]
pub struct SignatureRejection(pub StatusCode, pub String);

#[cfg(feature = "server")]
impl IntoResponse for SignatureRejection {
    fn into_response(self) -> Response {
        (self.0, self.1).into_response()
    }
}
