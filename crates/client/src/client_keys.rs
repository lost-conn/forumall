//! Client-side Ed25519 key generation and signing for OFSCP authentication.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Ed25519 keypair stored as base64 strings
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct KeyPair {
    pub public_key: String,  // Base64
    pub private_key: String, // Base64
    pub key_id: Option<String>,
}

const STORAGE_KEY: &str = "ofscp_client_keys";

/// Generate a new Ed25519 keypair
pub fn generate_keypair() -> KeyPair {
    let mut csprng = OsRng;
    let signing_key = SigningKey::generate(&mut csprng);
    let verifying_key = signing_key.verifying_key();

    let private_key_b64 = BASE64.encode(signing_key.to_bytes());
    let public_key_b64 = BASE64.encode(verifying_key.as_bytes());

    KeyPair {
        public_key: public_key_b64,
        private_key: private_key_b64,
        key_id: None,
    }
}

/// Save keypair to localStorage
#[allow(dead_code)]
pub fn save_keypair(keys: &KeyPair) {
    if let Ok(json) = serde_json::to_string(keys) {
        if let Some(win) = web_sys::window() {
            if let Ok(Some(storage)) = win.local_storage() {
                let _ = storage.set_item(STORAGE_KEY, &json);
            }
        }
    }
}

/// Load keypair from localStorage
#[allow(dead_code)]
pub fn load_keypair() -> Option<KeyPair> {
    if let Some(win) = web_sys::window() {
        if let Ok(Some(storage)) = win.local_storage() {
            if let Ok(Some(json)) = storage.get_item(STORAGE_KEY) {
                return serde_json::from_str(&json).ok();
            }
        }
    }
    None
}

/// Clear keypair from localStorage
pub fn clear_keypair() {
    if let Some(win) = web_sys::window() {
        if let Ok(Some(storage)) = win.local_storage() {
            let _ = storage.remove_item(STORAGE_KEY);
        }
    }
}

/// OFSCP signature headers for HTTP requests
#[derive(Clone, Debug)]
pub struct SignedHeaders {
    pub actor: String,
    pub key_id: String,
    pub timestamp: String,
    pub signature: String,
}

/// Sign an HTTP request with OFSCP signature
pub fn sign_request(
    method: &str,
    path: &str,
    body: &[u8],
    keys: &KeyPair,
    handle: &str,
    domain: &str,
) -> Option<SignedHeaders> {
    let key_id = keys.key_id.as_ref()?;

    let priv_bytes = BASE64.decode(&keys.private_key).ok()?;
    let priv_arr: [u8; 32] = priv_bytes.try_into().ok()?;
    let signing_key = SigningKey::from_bytes(&priv_arr);

    let timestamp = Utc::now().to_rfc3339();
    let body_hash = hex::encode(Sha256::digest(body));

    let canonical = format!("{}\n{}\n{}\n{}", method, path, timestamp, body_hash);

    let signature = signing_key.sign(canonical.as_bytes());
    let sig_b64 = BASE64.encode(signature.to_bytes());

    Some(SignedHeaders {
        actor: format!("@{}@{}", handle, domain),
        key_id: key_id.clone(),
        timestamp,
        signature: sig_b64,
    })
}

/// WebSocket authentication parameters (passed via query string)
#[derive(Clone, Debug)]
pub struct WsAuthParams {
    pub actor: String,
    pub key_id: String,
    pub timestamp: String,
    pub signature: String,
}

impl WsAuthParams {
    /// Convert to URL query string format
    pub fn to_query_string(&self) -> String {
        format!(
            "actor={}&timestamp={}&keyId={}&signature={}",
            urlencoding::encode(&self.actor),
            urlencoding::encode(&self.timestamp),
            urlencoding::encode(&self.key_id),
            urlencoding::encode(&self.signature)
        )
    }
}

/// Sign a WebSocket upgrade request (GET with empty body)
pub fn sign_ws_request(
    path: &str,
    keys: &KeyPair,
    handle: &str,
    domain: &str,
) -> Option<WsAuthParams> {
    let key_id = keys.key_id.as_ref()?;

    let priv_bytes = BASE64.decode(&keys.private_key).ok()?;
    let priv_arr: [u8; 32] = priv_bytes.try_into().ok()?;
    let signing_key = SigningKey::from_bytes(&priv_arr);

    let timestamp = Utc::now().to_rfc3339();
    let body_hash = hex::encode(Sha256::digest(&[]));

    let canonical = format!("GET\n{}\n{}\n{}", path, timestamp, body_hash);

    let signature = signing_key.sign(canonical.as_bytes());
    let sig_b64 = BASE64.encode(signature.to_bytes());

    Some(WsAuthParams {
        actor: format!("@{}@{}", handle, domain),
        key_id: key_id.clone(),
        timestamp,
        signature: sig_b64,
    })
}
