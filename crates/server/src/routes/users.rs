//! User routes.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use forumall_shared::{AddJoinedGroupRequest, UserJoinedGroup, UserProfile};

use crate::middleware::signature::{SignedJson, SignedRequest};
use crate::state::AppState;

/// Get user's joined groups
pub async fn get_user_groups(
    State(state): State<AppState>,
    Path(user_id): Path<String>,
    signed: SignedRequest,
) -> Result<Json<Vec<UserJoinedGroup>>, (StatusCode, String)> {
    if signed.user_id != user_id {
        return Err((StatusCode::FORBIDDEN, "You can only view your own joined groups".to_string()));
    }

    let groups = state.db
        .query("user_joined_groups")
        .filter(|f| f.eq("user_id", user_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?
        .into_iter()
        .map(|doc| {
            UserJoinedGroup {
                group_id: doc.data.get("group_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                host: doc.data.get("host").and_then(|v| v.as_str()).map(|s| s.to_string()),
                name: doc.data.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                joined_at: doc.data.get("joined_at").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            }
        })
        .collect();

    Ok(Json(groups))
}

/// Get user profile (public)
pub async fn get_user_profile(
    State(state): State<AppState>,
    Path(handle): Path<String>,
) -> Result<Json<UserProfile>, (StatusCode, String)> {
    let user_doc = state.db
        .query("users")
        .filter(|f| f.eq("handle", handle.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?
        .into_iter()
        .next()
        .ok_or_else(|| (StatusCode::NOT_FOUND, "User not found".to_string()))?;

    let handle = user_doc.data.get("handle").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let domain = user_doc.data.get("domain").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let updated_at_str = user_doc.data.get("updated_at").and_then(|v| v.as_str()).unwrap_or("");

    let updated_at = chrono::DateTime::parse_from_rfc3339(updated_at_str)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .unwrap_or_else(|_| chrono::Utc::now());

    Ok(Json(UserProfile {
        handle,
        domain,
        display_name: None,
        avatar: None,
        updated_at,
        metadata: vec![],
    }))
}

/// Add a joined group to a user
pub async fn add_user_joined_group(
    State(state): State<AppState>,
    Path(user_id): Path<String>,
    SignedJson { value: payload, user_id: auth_user, .. }: SignedJson<AddJoinedGroupRequest>,
) -> Result<Json<UserJoinedGroup>, (StatusCode, String)> {
    if auth_user != user_id {
        return Err((StatusCode::FORBIDDEN, "Unauthorized".to_string()));
    }

    let now = chrono::Utc::now().to_rfc3339();
    let host = payload.host.clone().unwrap_or_else(|| "localhost".to_string());

    state.db
        .insert_into(
            "user_joined_groups",
            vec![
                ("user_id", user_id.into()),
                ("group_id", payload.group_id.clone().into()),
                ("host", host.clone().into()),
                ("name", payload.name.clone().into()),
                ("joined_at", now.clone().into()),
            ],
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    Ok(Json(UserJoinedGroup {
        group_id: payload.group_id,
        host: Some(host),
        name: payload.name,
        joined_at: now,
    }))
}

/// Add a joined group for the current user (/api/me/groups)
pub async fn add_self_joined_group(
    State(state): State<AppState>,
    SignedJson { value: payload, user_id, .. }: SignedJson<AddJoinedGroupRequest>,
) -> Result<Json<UserJoinedGroup>, (StatusCode, String)> {
    let now = chrono::Utc::now().to_rfc3339();
    let host = payload.host.clone().unwrap_or_else(|| "localhost".to_string());

    state.db
        .insert_into(
            "user_joined_groups",
            vec![
                ("user_id", user_id.into()),
                ("group_id", payload.group_id.clone().into()),
                ("host", host.clone().into()),
                ("name", payload.name.clone().into()),
                ("joined_at", now.clone().into()),
            ],
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    Ok(Json(UserJoinedGroup {
        group_id: payload.group_id,
        host: Some(host),
        name: payload.name,
        joined_at: now,
    }))
}

/// Remove a joined group from the current user's history (/api/me/groups/{group_id})
/// This does NOT require being a member of the group - it only removes the local history entry.
pub async fn remove_self_joined_group(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    signed: SignedRequest,
) -> Result<StatusCode, (StatusCode, String)> {
    // Find and delete matching entries for this user
    let entries: Vec<_> = state.db
        .query("user_joined_groups")
        .filter(|f| f.eq("user_id", signed.user_id.clone()))
        .filter(|f| f.eq("group_id", group_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    if entries.is_empty() {
        return Err((StatusCode::NOT_FOUND, "Group not found in your history".to_string()));
    }

    // Delete all matching entries (there should typically be only one)
    for entry in entries {
        state.db
            .delete(&format!("user_joined_groups:{}", entry.id))
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;
    }

    Ok(StatusCode::NO_CONTENT)
}
