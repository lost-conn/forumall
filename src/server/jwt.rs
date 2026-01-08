//! JWT helpers for OFSCP authentication.
//!
//! This module is intentionally small and provider-local.
//!
//! - Access tokens are JWTs signed with RS256.
//! - For now we keep a dev keypair in-process (generated at startup).
//! - Federation/discovery (JWKS) is handled separately.

#[cfg(feature = "server")]
use anyhow::{Context, Result};

#[cfg(feature = "server")]
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};

#[cfg(feature = "server")]
use once_cell::sync::Lazy;

#[cfg(feature = "server")]
use rand::{rngs::OsRng, RngCore};

#[cfg(feature = "server")]
use serde::{Deserialize, Serialize};

#[cfg(feature = "server")]
static DEV_RSA_KEYPAIR: Lazy<RsaKeyPair> = Lazy::new(|| {
    // Dev-only: generate a fresh RSA keypair at startup. This means tokens become invalid on restart.
    // For production, load keys from disk or KMS and rotate via `kid`.
    RsaKeyPair::generate().expect("generate RSA keypair")
});

#[cfg(feature = "server")]
#[derive(Clone)]
struct RsaKeyPair {
    kid: String,
    encoding: EncodingKey,
    decoding: DecodingKey,
    // Public JWK fields
    n_b64u: String,
    e_b64u: String,
}

#[cfg(feature = "server")]
impl RsaKeyPair {
    fn generate() -> Result<Self> {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;
        use rsa::pkcs1::{EncodeRsaPrivateKey, EncodeRsaPublicKey};
        use rsa::traits::PublicKeyParts;

        let private = rsa::RsaPrivateKey::new(&mut OsRng, 2048)
            .map_err(|e| anyhow::anyhow!("generate rsa private key: {e}"))?;
        let public = rsa::RsaPublicKey::from(&private);

        // jsonwebtoken uses PKCS#1 PEM for RSA keys.
        let private_pem = private
            .to_pkcs1_pem(rsa::pkcs1::LineEnding::LF)
            .map_err(|e| anyhow::anyhow!("encode private key pem: {e}"))?;
        let public_pem = public
            .to_pkcs1_pem(rsa::pkcs1::LineEnding::LF)
            .map_err(|e| anyhow::anyhow!("encode public key pem: {e}"))?;

        let encoding = EncodingKey::from_rsa_pem(private_pem.as_bytes()).context("encoding key")?;
        let decoding = DecodingKey::from_rsa_pem(public_pem.as_bytes()).context("decoding key")?;

        // kid: short random; good enough for dev.
        let mut kid_bytes = [0u8; 8];
        OsRng.fill_bytes(&mut kid_bytes);
        let kid = hex::encode(kid_bytes);

        // Build JWKS fields. For RSA, use base64url(no-pad) of big-endian bytes.
        let n_b64u = URL_SAFE_NO_PAD.encode(public.n().to_bytes_be());
        let e_b64u = URL_SAFE_NO_PAD.encode(public.e().to_bytes_be());

        Ok(Self {
            kid,
            encoding,
            decoding,
            n_b64u,
            e_b64u,
        })
    }
}

/// Minimal JWT claims for OFSCP access tokens.
#[cfg(feature = "server")]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessTokenClaims {
    pub iss: String,
    pub sub: String,
    pub aud: String,
    pub exp: usize,
    pub iat: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jti: Option<String>,
}

/// Issue a JWT access token for a local user.
///
/// This is a stepping stone toward OFSCP OAuth2 token issuance.
#[cfg(feature = "server")]
pub fn issue_access_token(user_id: &str) -> Result<String> {
    let now = chrono::Utc::now();
    let iat = now.timestamp() as usize;
    let exp = (now + chrono::Duration::days(30)).timestamp() as usize;

    let claims = AccessTokenClaims {
        iss: "https://localhost".to_string(),
        sub: user_id.to_string(),
        aud: "https://localhost".to_string(),
        iat,
        exp,
        jti: Some(uuid::Uuid::new_v4().to_string()),
    };

    let mut header = Header::new(Algorithm::RS256);
    header.typ = Some("JWT".to_string());
    header.kid = Some(DEV_RSA_KEYPAIR.kid.clone());

    jsonwebtoken::encode(&header, &claims, &DEV_RSA_KEYPAIR.encoding).context("encode jwt")
}

/// Validate an incoming JWT and return claims.
#[cfg(feature = "server")]
pub fn validate_access_token(token: &str) -> Result<AccessTokenClaims> {
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&["https://localhost"]);
    validation.set_issuer(&["https://localhost"]);

    let data =
        jsonwebtoken::decode::<AccessTokenClaims>(token, &DEV_RSA_KEYPAIR.decoding, &validation)
            .context("decode jwt")?;
    Ok(data.claims)
}

/// JWKS representation for the dev key.
#[cfg(feature = "server")]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Jwks {
    pub keys: Vec<Jwk>,
}

/// Client-build placeholder type.
///
/// The web build doesn't need the real JWKS shape, but `src/main.rs` references `Jwks`
/// in a handler return type.
#[cfg(not(feature = "server"))]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Jwks {
    pub keys: Vec<Jwk>,
}

#[cfg(not(feature = "server"))]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Jwk {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kty: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alg: Option<String>,
    #[serde(rename = "use", skip_serializing_if = "Option::is_none")]
    pub use_: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub n: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub e: Option<String>,
}

#[cfg(feature = "server")]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Jwk {
    pub kty: String,
    pub kid: String,
    pub alg: String,
    #[serde(rename = "use")]
    pub use_: String,
    pub n: String,
    pub e: String,
}

#[cfg(feature = "server")]
pub fn jwks() -> Jwks {
    Jwks {
        keys: vec![Jwk {
            kty: "RSA".to_string(),
            kid: DEV_RSA_KEYPAIR.kid.clone(),
            alg: "RS256".to_string(),
            use_: "sig".to_string(),
            n: DEV_RSA_KEYPAIR.n_b64u.clone(),
            e: DEV_RSA_KEYPAIR.e_b64u.clone(),
        }],
    }
}

#[cfg(not(feature = "server"))]
pub fn issue_access_token(_user_id: &str) -> Result<String, String> {
    Err("JWT issuance is server-only".to_string())
}
