//! OFSCP protocol definitions and signature utilities.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use sha2::{Digest, Sha256};

/// OFSCP header names
pub const HEADER_SIGNATURE: &str = "X-OFSCP-Signature";
pub const HEADER_ACTOR: &str = "X-OFSCP-Actor";
pub const HEADER_TIMESTAMP: &str = "X-OFSCP-Timestamp";

/// Parsed OFSCP signature header
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OFSCPSignature {
    pub key_id: String,
    pub signature: String,
}

impl OFSCPSignature {
    /// Parse a signature header value like:
    /// `keyId="device_abc123", signature="base64signature=="`
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

    /// Format the signature header value
    pub fn to_header_value(&self) -> String {
        format!(
            "keyId=\"{}\", signature=\"{}\"",
            self.key_id, self.signature
        )
    }
}

/// Construct the signature base string for OFSCP requests.
/// Format: `{METHOD}\n{PATH}\n{TIMESTAMP}\n{BODY_HASH}`
pub fn construct_signature_base(method: &str, path: &str, timestamp: &str, body: &[u8]) -> String {
    let body_hash = hex::encode(Sha256::digest(body));
    format!("{}\n{}\n{}\n{}", method, path, timestamp, body_hash)
}

/// Verify an Ed25519 signature against a message and public key.
pub fn verify_signature(
    public_key_base64: &str,
    signature_base64: &str,
    message: &[u8],
) -> Result<(), String> {
    let decoded_sig = BASE64
        .decode(signature_base64)
        .map_err(|_| "Invalid base64 signature")?;
    let decoded_pubkey = BASE64
        .decode(public_key_base64)
        .map_err(|_| "Invalid base64 public key")?;

    let public_key = ed25519_dalek::VerifyingKey::from_bytes(
        &decoded_pubkey
            .try_into()
            .map_err(|_| "Invalid public key length")?,
    )
    .map_err(|_| "Invalid public key")?;

    let signature = ed25519_dalek::Signature::from_bytes(
        &decoded_sig
            .try_into()
            .map_err(|_| "Invalid signature length")?,
    );

    use ed25519_dalek::Verifier;
    public_key
        .verify(message, &signature)
        .map_err(|e| format!("Signature verification failed: {}", e))
}

/// Create an Ed25519 signature of a message.
pub fn create_signature(signing_key: &ed25519_dalek::SigningKey, message: &[u8]) -> String {
    use ed25519_dalek::Signer;
    let signature = signing_key.sign(message);
    BASE64.encode(signature.to_bytes())
}

/// Normalize an actor ID to just the handle.
/// Strips `@handle@domain` format to just `handle`.
pub fn normalize_actor_id(actor: &str) -> String {
    if actor.starts_with('@') {
        let segments: Vec<&str> = actor.split('@').collect();
        if segments.len() >= 2 {
            return segments[1].to_string();
        }
    }
    actor.to_string()
}

/// Check if a host is a local/development address.
pub fn is_local_address(host: &str) -> bool {
    let host_part = host.split(':').next().unwrap_or(host);
    host_part == "localhost"
        || host_part == "127.0.0.1"
        || host_part == "0.0.0.0"
        || host_part.starts_with("192.168.")
        || host_part.starts_with("10.")
}
