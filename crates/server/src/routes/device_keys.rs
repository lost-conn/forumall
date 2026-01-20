//! Device key management routes.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use forumall_shared::{
    DeviceKey, DiscoveryKey, PublicKeyDiscoveryResponse, RegisterDeviceKeyRequest,
    RegisterDeviceKeyResponse,
};

use crate::middleware::signature::SignedJson;
use crate::state::AppState;

/// Register a new device key (requires OFSCP signature)
pub async fn register_device_key(
    State(state): State<AppState>,
    SignedJson { value: payload, user_id, .. }: SignedJson<RegisterDeviceKeyRequest>,
) -> Result<Json<RegisterDeviceKeyResponse>, (StatusCode, String)> {
    if payload.public_key.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Public key is required".to_string()));
    }
    if payload.device_name.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Device name is required".to_string()));
    }

    let key_id = format!("dk_{}", uuid::Uuid::new_v4().to_string().replace("-", ""));
    let now = chrono::Utc::now().to_rfc3339();

    state.db
        .insert_into(
            "device_keys",
            vec![
                ("key_id", key_id.clone().into()),
                ("user_handle", user_id.into()),
                ("public_key", payload.public_key.into()),
                ("device_name", payload.device_name.into()),
                ("created_at", now.clone().into()),
                ("last_used_at", now.clone().into()),
                ("revoked", "false".into()),
            ],
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?;

    Ok(Json(RegisterDeviceKeyResponse {
        key_id,
        created_at: now,
    }))
}

/// List device keys for the authenticated user
pub async fn list_device_keys(
    State(state): State<AppState>,
    signed: crate::middleware::signature::SignedRequest,
) -> Result<Json<Vec<DeviceKey>>, (StatusCode, String)> {
    let keys = state.db
        .query("device_keys")
        .filter(|f| f.eq("user_handle", signed.user_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?
        .into_iter()
        .map(|doc| {
            DeviceKey {
                key_id: doc.data.get("key_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                user_handle: doc.data.get("user_handle").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                public_key: doc.data.get("public_key").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                device_name: doc.data.get("device_name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                created_at: doc.data.get("created_at").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                last_used_at: doc.data.get("last_used_at").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                revoked: doc.data.get("revoked").and_then(|v| v.as_str()).map(|s| s == "true").unwrap_or(false),
            }
        })
        .collect();

    Ok(Json(keys))
}

/// Revoke a device key
pub async fn revoke_device_key(
    State(state): State<AppState>,
    Path(key_id): Path<String>,
    signed: crate::middleware::signature::SignedRequest,
) -> Result<StatusCode, (StatusCode, String)> {
    let mut keys = state.db
        .query("device_keys")
        .filter(|f| f.eq("key_id", key_id.clone()))
        .filter(|f| f.eq("user_handle", signed.user_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?;

    if keys.is_empty() {
        return Err((StatusCode::NOT_FOUND, "Key not found or unauthorized".to_string()));
    }

    let doc = keys.pop().unwrap();

    state.db
        .update_document("device_keys", &doc.id, vec![("revoked", "true".into())])
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?;

    Ok(StatusCode::NO_CONTENT)
}

/// Get public keys for a user (public endpoint for OFSCP key discovery)
pub async fn get_public_keys(
    State(state): State<AppState>,
    Path(handle): Path<String>,
) -> Json<PublicKeyDiscoveryResponse> {
    let keys: Vec<DiscoveryKey> = state.db
        .query("device_keys")
        .filter(|f| f.eq("user_handle", handle.clone()))
        .filter(|f| f.eq("revoked", "false"))
        .collect()
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|doc| {
            DiscoveryKey {
                key_id: doc.data.get("key_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                algorithm: "Ed25519".to_string(),
                public_key: doc.data.get("public_key").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                created_at: doc.data.get("created_at").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            }
        })
        .collect();

    let domain = state.domain();
    let actor = format!("@{}@{}", handle, domain);

    let now = chrono::Utc::now();
    let cache_until = (now + chrono::Duration::hours(1)).to_rfc3339();

    Json(PublicKeyDiscoveryResponse {
        actor,
        keys,
        cache_until,
    })
}
