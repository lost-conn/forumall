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

    Ok((actor_handle.to_string(), sig_header.key_id))
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

    // 2. Optimization: if local domain, query DB directly
    if domain == "localhost" || domain == "127.0.0.1" {
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
        return Err("Key not found locally".to_string());
    }

    // 3. Remote fetching (future implementation)
    Err("Remote key fetching not yet implemented".to_string())
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
