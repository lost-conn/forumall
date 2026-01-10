use dioxus::logger::tracing;
use dioxus::prelude::ServerFnError;
use dioxus_fullstack::{post, Json};
use serde::{Deserialize, Serialize};

pub mod client_keys;

#[cfg(feature = "server")]
use crate::server::middleware::cors::api_cors_layer;

#[cfg(feature = "server")]
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterRequest {
    pub handle: String,
    pub password: String,
    pub device_public_key: Option<String>,
    pub device_name: Option<String>,
}

#[post("/api/auth/register")]
#[middleware(api_cors_layer())]
pub async fn register(payload: Json<RegisterRequest>) -> Result<LoginResponse, ServerFnError> {
    let payload = payload.0;
    tracing::info!("Registering user: {}", payload.handle);

    if !crate::models::validate_resource_name(&payload.handle) {
        return Err(ServerFnError::new(
            "Invalid handle. Must be lowercase alphanumeric, periods, underscores, or dashes.",
        ));
    }

    let domain = "localhost".to_string();
    let now = chrono::Utc::now().to_rfc3339();

    #[cfg(feature = "server")]
    {
        let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
        let argon2 = Argon2::default();
        let password_hash = argon2
            .hash_password(payload.password.as_bytes(), &salt)
            .map_err(|e| ServerFnError::new(format!("Hashing error: {e}")))?
            .to_string();

        let db = &*crate::DB;
        db.insert_into(
            "users",
            vec![
                ("handle", payload.handle.clone().into()),
                ("domain", domain.into()),
                ("password_hash", password_hash.into()),
                ("updated_at", now.clone().into()),
                ("created_at", now.clone().into()),
            ],
        )
        .await
        .map_err(|e| {
            tracing::error!("Database error during registration: {:?}", e);
            ServerFnError::new(format!("Database error: {e}"))
        })?;

        let now_for_key = chrono::Utc::now().to_rfc3339();
        if let Some(pub_key) = payload.device_public_key {
            let key_id = format!("device_{}", uuid::Uuid::new_v4());
            db.insert_into(
                "device_keys",
                vec![
                    ("key_id", key_id.clone().into()),
                    ("user_handle", payload.handle.clone().into()),
                    ("public_key", pub_key.into()),
                    (
                        "device_name",
                        payload
                            .device_name
                            .unwrap_or_else(|| "Unknown device".to_string())
                            .into(),
                    ),
                    ("created_at", now_for_key.clone().into()),
                    ("last_used_at", now_for_key.into()),
                    ("revoked", "false".into()),
                ],
            )
            .await
            .map_err(|e| ServerFnError::new(format!("Failed to register device key: {e}")))?;

            Ok(LoginResponse {
                user_id: payload.handle,
                key_id: Some(key_id),
            })
        } else {
            Ok(LoginResponse {
                user_id: payload.handle,
                key_id: None,
            })
        }
    }
    #[cfg(not(feature = "server"))]
    {
        Ok(LoginResponse {
            user_id: "dev-user".to_string(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginRequest {
    pub handle: String,
    pub password: String,
    pub device_public_key: Option<String>,
    pub device_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginResponse {
    pub user_id: String,
    pub key_id: Option<String>,
}

#[post("/api/auth/login")]
#[middleware(api_cors_layer())]
pub async fn login(payload: Json<LoginRequest>) -> Result<LoginResponse, ServerFnError> {
    let payload = payload.0;
    tracing::info!("Logging in user: {}", payload.handle);

    #[cfg(feature = "server")]
    {
        let db = &*crate::DB;

        let user = db
            .query("users")
            .filter(|f| f.eq("handle", payload.handle.clone()))
            .collect()
            .await
            .map_err(|e| ServerFnError::new(format!("Database error: {e}")))?
            .into_iter()
            .next()
            .ok_or_else(|| ServerFnError::new("User not found"))?;

        let user_handle = user
            .data
            .get("handle")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let user_password_hash = user
            .data
            .get("password_hash")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let argon2 = Argon2::default();
        let parsed_hash = PasswordHash::new(&user_password_hash)
            .map_err(|e| ServerFnError::new(format!("Invalid hash: {e}")))?;

        argon2
            .verify_password(payload.password.as_bytes(), &parsed_hash)
            .map_err(|_| ServerFnError::new("Invalid password"))?;

        let now_for_key = chrono::Utc::now().to_rfc3339();
        if let Some(pub_key) = payload.device_public_key {
            let key_id = format!("device_{}", uuid::Uuid::new_v4());
            db.insert_into(
                "device_keys",
                vec![
                    ("key_id", key_id.clone().into()),
                    ("user_handle", user_handle.clone().into()),
                    ("public_key", pub_key.into()),
                    (
                        "device_name",
                        payload
                            .device_name
                            .unwrap_or_else(|| "Unknown device".to_string())
                            .into(),
                    ),
                    ("created_at", now_for_key.clone().into()),
                    ("last_used_at", now_for_key.into()),
                    ("revoked", "false".into()),
                ],
            )
            .await
            .map_err(|e| ServerFnError::new(format!("Failed to register device key: {e}")))?;

            Ok(LoginResponse {
                user_id: user_handle,
                key_id: Some(key_id),
            })
        } else {
            Ok(LoginResponse {
                user_id: user_handle,
                key_id: None,
            })
        }
    }
    #[cfg(not(feature = "server"))]
    {
        Ok(LoginResponse {
            user_id: "dev-user".to_string(),
        })
    }
}
