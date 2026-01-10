use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use ed25519_dalek::{Signer, SigningKey};
use hex;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct KeyPair {
    pub public_key: String,  // Base64
    pub private_key: String, // Base64
    pub key_id: Option<String>,
}

#[allow(dead_code)]
const STORAGE_KEY: &str = "ofscp_client_keys";

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

#[allow(dead_code)]
pub fn save_keypair(keys: &KeyPair) {
    if let Ok(json) = serde_json::to_string(keys) {
        #[cfg(feature = "web")]
        {
            use web_sys::window;
            if let Some(win) = window() {
                if let Ok(Some(storage)) = win.local_storage() {
                    let _ = storage.set_item(STORAGE_KEY, &json);
                }
            }
        }
    }
}

#[allow(dead_code)]
pub fn load_keypair() -> Option<KeyPair> {
    #[cfg(feature = "web")]
    {
        use web_sys::window;
        if let Some(win) = window() {
            if let Ok(Some(storage)) = win.local_storage() {
                if let Ok(Some(json)) = storage.get_item(STORAGE_KEY) {
                    return serde_json::from_str(&json).ok();
                }
            }
        }
    }
    None
}

pub fn clear_keypair() {
    #[cfg(feature = "web")]
    {
        use web_sys::window;
        if let Some(win) = window() {
            if let Ok(Some(storage)) = win.local_storage() {
                let _ = storage.remove_item(STORAGE_KEY);
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct SignedHeaders {
    pub actor: String,
    pub key_id: String,
    pub timestamp: String,
    pub signature: String,
}

pub fn sign_request(
    method: &str,
    path: &str,
    body: &[u8],
    keys: &KeyPair,
    handle: &str,
) -> Option<SignedHeaders> {
    let key_id = keys.key_id.as_ref()?;

    // Decode private key
    let priv_bytes = BASE64.decode(&keys.private_key).ok()?;
    let priv_arr: [u8; 32] = priv_bytes.try_into().ok()?;
    let signing_key = SigningKey::from_bytes(&priv_arr);

    let timestamp = Utc::now().to_rfc3339();
    let body_hash = hex::encode(Sha256::digest(body));

    let canonical = format!("{}\n{}\n{}\n{}", method, path, timestamp, body_hash);

    let signature = signing_key.sign(canonical.as_bytes());
    let sig_b64 = BASE64.encode(signature.to_bytes());

    Some(SignedHeaders {
        actor: format!("@{}", handle), // Assuming local domain for now or handle format handling
        key_id: key_id.clone(),
        timestamp,
        signature: sig_b64,
    })
}
