use dioxus::logger::tracing;
use dioxus::prelude::ServerFnError;
use dioxus_fullstack::{post, Json};
use serde::{Deserialize, Serialize};

#[cfg(feature = "server")]
use crate::server::jwt;

#[cfg(feature = "server")]
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterRequest {
    pub handle: String,
    pub password: String,
}

#[post("/api/auth/register")]
pub async fn register(
    payload: Json<RegisterRequest>,
) -> Result<Json<LoginResponse>, ServerFnError> {
    let payload = payload.0;
    tracing::info!("Registering user: {}", payload.handle);

    let id = uuid::Uuid::new_v4().to_string();
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
                ("id", id.clone().into()),
                ("handle", payload.handle.into()),
                ("domain", domain.into()),
                ("password_hash", password_hash.into()),
                ("updated_at", now.clone().into()),
                ("created_at", now.into()),
            ],
        )
        .await
        .map_err(|e| {
            tracing::error!("Database error during registration: {:?}", e);
            ServerFnError::new(format!("Database error: {e}"))
        })?;

        // Registration auto-logs-in by returning a new JWT bearer token.
        let token = jwt::issue_access_token(&id)
            .map_err(|e| ServerFnError::new(format!("Failed to issue token: {e}")))?;

        Ok(Json(LoginResponse {
            user_id: id.clone(),
            token,
        }))
    }
    #[cfg(not(feature = "server"))]
    {
        Ok(Json(LoginResponse {
            user_id: id,
            token: String::new(),
        }))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginRequest {
    pub handle: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginResponse {
    pub user_id: String,
    pub token: String,
}

#[post("/api/auth/login")]
pub async fn login(payload: Json<LoginRequest>) -> Result<Json<LoginResponse>, ServerFnError> {
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

        let user_id = user
            .data
            .get("id")
            .and_then(|v: &aurora_db::Value| v.as_str())
            .unwrap_or("")
            .to_string();
        let user_password_hash = user
            .data
            .get("password_hash")
            .and_then(|v: &aurora_db::Value| v.as_str())
            .unwrap_or("")
            .to_string();

        let argon2 = Argon2::default();
        let parsed_hash = PasswordHash::new(&user_password_hash)
            .map_err(|e| ServerFnError::new(format!("Invalid hash: {e}")))?;

        argon2
            .verify_password(payload.password.as_bytes(), &parsed_hash)
            .map_err(|_| ServerFnError::new("Invalid password"))?;

        // Issue a JWT bearer token
        let token = jwt::issue_access_token(&user_id)
            .map_err(|e| ServerFnError::new(format!("Failed to issue token: {e}")))?;

        Ok(Json(LoginResponse { user_id, token }))
    }
    #[cfg(not(feature = "server"))]
    Ok(Json(LoginResponse {
        user_id: String::new(),
        token: String::new(),
    }))
}
