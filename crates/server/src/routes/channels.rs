//! Channel management routes.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use forumall_shared::{Channel, CreateChannelRequest};

use crate::middleware::signature::{SignedJson, SignedRequest};
use crate::state::AppState;

/// Create a new channel in a group
pub async fn create_channel(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    SignedJson { value: payload, user_id, .. }: SignedJson<CreateChannelRequest>,
) -> Result<Json<Channel>, (StatusCode, String)> {
    if !forumall_shared::validate_resource_name(&payload.name) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Invalid channel name. Must be lowercase alphanumeric, periods, underscores, or dashes.".to_string(),
        ));
    }

    // Check membership
    let is_member = state.db
        .query("group_members")
        .filter(|f| f.eq("group_id", group_id.clone()) & f.eq("user_id", user_id.clone()))
        .collect()
        .await
        .map(|docs| !docs.is_empty())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    if !is_member {
        return Err((StatusCode::FORBIDDEN, "Not a group member".to_string()));
    }

    let channel_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    let channel = Channel {
        id: channel_id,
        group_id: group_id.clone(),
        name: payload.name,
        topic: payload.topic,
        created_at: now.clone(),
        updated_at: now,
    };

    state.db
        .insert_into(
            "channels",
            vec![
                ("id", channel.id.clone().into()),
                ("group_id", channel.group_id.clone().into()),
                ("name", channel.name.clone().into()),
                ("topic", channel.topic.as_deref().unwrap_or("").into()),
                ("created_at", channel.created_at.clone().into()),
                ("updated_at", channel.updated_at.clone().into()),
            ],
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    Ok(Json(channel))
}

/// List channels in a group
pub async fn list_channels(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    signed: SignedRequest,
) -> Result<Json<Vec<Channel>>, (StatusCode, String)> {
    // Check membership
    let is_member = state.db
        .query("group_members")
        .filter(|f| f.eq("group_id", group_id.clone()) & f.eq("user_id", signed.user_id.clone()))
        .collect()
        .await
        .map(|docs| !docs.is_empty())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    if !is_member {
        return Err((StatusCode::FORBIDDEN, "Not a group member".to_string()));
    }

    let mut channels: Vec<Channel> = state.db
        .query("channels")
        .filter(|f| f.eq("group_id", group_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?
        .into_iter()
        .map(|doc| {
            Channel {
                id: doc.data.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                group_id: doc.data.get("group_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                name: doc.data.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                topic: doc.data.get("topic").and_then(|v| v.as_str()).map(|s| s.to_string()),
                created_at: doc.data.get("created_at").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                updated_at: doc.data.get("updated_at").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            }
        })
        .collect();

    channels.sort_by(|a, b| a.created_at.cmp(&b.created_at));

    Ok(Json(channels))
}
