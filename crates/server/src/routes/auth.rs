//! Authentication routes (register, login).

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{extract::State, http::StatusCode, Json};
use forumall_shared::{LoginRequest, LoginResponse, RegisterRequest};

use crate::state::AppState;

/// Register a new user account
pub async fn register(
    State(state): State<AppState>,
    Json(payload): Json<RegisterRequest>,
) -> Result<Json<LoginResponse>, (StatusCode, String)> {
    tracing::info!("Registering user: {}", payload.handle);

    if !forumall_shared::validate_resource_name(&payload.handle) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Invalid handle. Must be lowercase alphanumeric, periods, underscores, or dashes.".to_string(),
        ));
    }

    let domain = state.domain();
    let now = chrono::Utc::now().to_rfc3339();

    // Hash password
    let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
    let argon2 = Argon2::default();
    let password_hash = argon2
        .hash_password(payload.password.as_bytes(), &salt)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Hashing error: {e}")))?
        .to_string();

    // Insert user
    state.db
        .insert_into(
            "users",
            vec![
                ("handle", payload.handle.clone().into()),
                ("domain", domain.clone().into()),
                ("password_hash", password_hash.into()),
                ("updated_at", now.clone().into()),
                ("created_at", now.clone().into()),
            ],
        )
        .await
        .map_err(|e| {
            tracing::error!("Database error during registration: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}"))
        })?;

    // Register device key if provided
    let key_id = if let Some(pub_key) = payload.device_public_key {
        let key_id = format!("device_{}", uuid::Uuid::new_v4());
        let now_for_key = chrono::Utc::now().to_rfc3339();

        state.db
            .insert_into(
                "device_keys",
                vec![
                    ("key_id", key_id.clone().into()),
                    ("user_handle", payload.handle.clone().into()),
                    ("public_key", pub_key.into()),
                    ("device_name", payload.device_name.unwrap_or_else(|| "Unknown device".to_string()).into()),
                    ("created_at", now_for_key.clone().into()),
                    ("last_used_at", now_for_key.into()),
                    ("revoked", "false".into()),
                ],
            )
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to register device key: {e}")))?;

        Some(key_id)
    } else {
        None
    };

    Ok(Json(LoginResponse {
        user_id: format!("{}@{}", payload.handle, domain),
        key_id,
    }))
}

/// Login to an existing account
pub async fn login(
    State(state): State<AppState>,
    Json(payload): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, (StatusCode, String)> {
    tracing::info!("Logging in user: {}", payload.handle);

    let domain = state.domain();

    // Find user
    let user = state.db
        .query("users")
        .filter(|f| f.eq("handle", payload.handle.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?
        .into_iter()
        .next()
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "User not found".to_string()))?;

    let user_handle = user.data
        .get("handle")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let user_password_hash = user.data
        .get("password_hash")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // Verify password
    let argon2 = Argon2::default();
    let parsed_hash = PasswordHash::new(&user_password_hash)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Invalid hash: {e}")))?;

    argon2
        .verify_password(payload.password.as_bytes(), &parsed_hash)
        .map_err(|_| (StatusCode::UNAUTHORIZED, "Invalid password".to_string()))?;

    // Register device key if provided
    let key_id = if let Some(pub_key) = payload.device_public_key {
        let key_id = format!("device_{}", uuid::Uuid::new_v4());
        let now = chrono::Utc::now().to_rfc3339();

        state.db
            .insert_into(
                "device_keys",
                vec![
                    ("key_id", key_id.clone().into()),
                    ("user_handle", user_handle.clone().into()),
                    ("public_key", pub_key.into()),
                    ("device_name", payload.device_name.unwrap_or_else(|| "Unknown device".to_string()).into()),
                    ("created_at", now.clone().into()),
                    ("last_used_at", now.into()),
                    ("revoked", "false".into()),
                ],
            )
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to register device key: {e}")))?;

        Some(key_id)
    } else {
        None
    };

    Ok(Json(LoginResponse {
        user_id: format!("{}@{}", user_handle, domain),
        key_id,
    }))
}
