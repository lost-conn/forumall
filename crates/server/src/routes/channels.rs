//! Channel management routes.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use forumall_shared::{
    Channel, ChannelSettings, ChannelType, CreateChannelRequest, Discoverability, Metadata,
    PermissionTarget, UpdateChannelRequest, UpdateChannelSettingsRequest,
};

use crate::middleware::signature::{SignedJson, SignedRequest};
use crate::state::AppState;

/// Permission type for channel access
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ChannelPermission {
    View,
    Send,
}

/// Check if a user has a specific permission in a channel.
/// Returns Ok(true) if allowed, Ok(false) if denied, Err on database error.
pub async fn check_channel_permission(
    state: &AppState,
    user_id: &str,
    group_id: &str,
    channel_settings: &ChannelSettings,
    permission: ChannelPermission,
) -> Result<bool, (StatusCode, String)> {
    let targets: &Vec<PermissionTarget> = match permission {
        ChannelPermission::View => &channel_settings.permissions.view,
        ChannelPermission::Send => &channel_settings.permissions.send,
    };

    // Check explicit user ID
    if targets.contains(&user_id.to_string()) {
        return Ok(true);
    }

    // Get user's membership info
    let member_docs = state
        .db
        .query("group_members")
        .filter(|f| f.eq("group_id", group_id.to_string()) & f.eq("user_id", user_id.to_string()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    let member_doc = match member_docs.first() {
        Some(doc) => doc,
        None => return Ok(false), // Not a member
    };

    let user_role = member_doc
        .data
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // Check each target
    for target in targets {
        if target == "@everyone" {
            // User is a member, so @everyone applies
            return Ok(true);
        }

        if target == "@owner" && user_role == "owner" {
            return Ok(true);
        }

        if target == "@admin" && (user_role == "admin" || user_role == "owner") {
            return Ok(true);
        }

        // Check custom roles (e.g., @moderator)
        if let Some(role_name) = target.strip_prefix('@') {
            if user_role == role_name {
                return Ok(true);
            }
        }
    }

    Ok(false)
}

/// Get channel settings from a channel document
pub fn get_settings_from_doc(doc: &aurora_db::Document) -> ChannelSettings {
    doc.data
        .get("settings")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default()
}

/// Helper to deserialize Channel from a database document
fn channel_from_doc(doc: &aurora_db::Document) -> Channel {
    let settings: ChannelSettings = doc
        .data
        .get("settings")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    let tags: Vec<String> = doc
        .data
        .get("tags")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    let metadata: Metadata = doc
        .data
        .get("metadata")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    let channel_type: ChannelType = doc
        .data
        .get("channel_type")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str(&format!("\"{}\"", s)).ok())
        .unwrap_or_default();

    let discoverability: Option<Discoverability> = doc
        .data
        .get("discoverability")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .and_then(|s| serde_json::from_str(&format!("\"{}\"", s)).ok());

    Channel {
        id: doc
            .data
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        group_id: doc
            .data
            .get("group_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        name: doc
            .data
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        channel_type,
        topic: doc
            .data
            .get("topic")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string()),
        discoverability,
        settings,
        tags,
        metadata,
        created_at: doc
            .data
            .get("created_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        updated_at: doc
            .data
            .get("updated_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    }
}

/// Create a new channel in a group
pub async fn create_channel(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    SignedJson {
        value: payload,
        user_id,
        ..
    }: SignedJson<CreateChannelRequest>,
) -> Result<Json<Channel>, (StatusCode, String)> {
    if !forumall_shared::validate_resource_name(&payload.name) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Invalid channel name. Must be lowercase alphanumeric, periods, underscores, or dashes."
                .to_string(),
        ));
    }

    // Check membership
    let is_member = state
        .db
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

    let settings = payload.settings.unwrap_or_default();
    let tags = payload.tags.unwrap_or_default();
    let channel_type = payload.channel_type.unwrap_or_default();

    let channel = Channel {
        id: channel_id,
        group_id: group_id.clone(),
        name: payload.name,
        channel_type: channel_type.clone(),
        topic: payload.topic,
        discoverability: payload.discoverability.clone(),
        settings: settings.clone(),
        tags: tags.clone(),
        metadata: vec![],
        created_at: now.clone(),
        updated_at: now,
    };

    let settings_json =
        serde_json::to_string(&settings).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Serialization error: {}", e)))?;
    let tags_json =
        serde_json::to_string(&tags).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Serialization error: {}", e)))?;
    let channel_type_str = serde_json::to_string(&channel_type)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Serialization error: {}", e)))?
        .trim_matches('"')
        .to_string();
    let discoverability_str = payload
        .discoverability
        .as_ref()
        .map(|d| {
            serde_json::to_string(d)
                .unwrap_or_default()
                .trim_matches('"')
                .to_string()
        })
        .unwrap_or_default();

    state
        .db
        .insert_into(
            "channels",
            vec![
                ("id", channel.id.clone().into()),
                ("group_id", channel.group_id.clone().into()),
                ("name", channel.name.clone().into()),
                ("channel_type", channel_type_str.into()),
                ("topic", channel.topic.as_deref().unwrap_or("").into()),
                ("discoverability", discoverability_str.into()),
                ("settings", settings_json.into()),
                ("tags", tags_json.into()),
                ("metadata", "[]".into()),
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
    // Check membership first
    let member_docs = state
        .db
        .query("group_members")
        .filter(|f| f.eq("group_id", group_id.clone()) & f.eq("user_id", signed.user_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    if member_docs.is_empty() {
        return Err((StatusCode::FORBIDDEN, "Not a group member".to_string()));
    }

    let all_channel_docs = state
        .db
        .query("channels")
        .filter(|f| f.eq("group_id", group_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    // Filter channels by view permission
    let mut visible_channels = Vec::new();
    for doc in &all_channel_docs {
        let settings = get_settings_from_doc(doc);
        let can_view = check_channel_permission(
            &state,
            &signed.user_id,
            &group_id,
            &settings,
            ChannelPermission::View,
        )
        .await?;

        if can_view {
            visible_channels.push(channel_from_doc(doc));
        }
    }

    visible_channels.sort_by(|a, b| a.created_at.cmp(&b.created_at));

    Ok(Json(visible_channels))
}

/// Get a single channel
pub async fn get_channel(
    State(state): State<AppState>,
    Path((group_id, channel_id)): Path<(String, String)>,
    signed: SignedRequest,
) -> Result<Json<Channel>, (StatusCode, String)> {
    let channel_doc = state
        .db
        .query("channels")
        .filter(|f| f.eq("id", channel_id.clone()) & f.eq("group_id", group_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?
        .into_iter()
        .next()
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Channel not found".to_string()))?;

    // Check view permission
    let settings = get_settings_from_doc(&channel_doc);
    let can_view = check_channel_permission(
        &state,
        &signed.user_id,
        &group_id,
        &settings,
        ChannelPermission::View,
    )
    .await?;

    if !can_view {
        return Err((StatusCode::FORBIDDEN, "You don't have permission to view this channel".to_string()));
    }

    Ok(Json(channel_from_doc(&channel_doc)))
}

/// Update a channel
pub async fn update_channel(
    State(state): State<AppState>,
    Path((group_id, channel_id)): Path<(String, String)>,
    SignedJson {
        value: payload,
        user_id,
        ..
    }: SignedJson<UpdateChannelRequest>,
) -> Result<Json<Channel>, (StatusCode, String)> {
    // Check if user is owner or admin
    let member_doc = state
        .db
        .query("group_members")
        .filter(|f| f.eq("group_id", group_id.clone()) & f.eq("user_id", user_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?
        .into_iter()
        .next()
        .ok_or_else(|| (StatusCode::FORBIDDEN, "Not a group member".to_string()))?;

    let role = member_doc
        .data
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if role != "owner" && role != "admin" {
        return Err((
            StatusCode::FORBIDDEN,
            "Only owners and admins can update channels".to_string(),
        ));
    }

    // Get existing channel
    let channel_docs = state
        .db
        .query("channels")
        .filter(|f| f.eq("id", channel_id.clone()) & f.eq("group_id", group_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    let channel_doc = channel_docs
        .first()
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Channel not found".to_string()))?;

    let mut existing = channel_from_doc(channel_doc);

    // Apply updates
    if let Some(name) = payload.name {
        if !forumall_shared::validate_resource_name(&name) {
            return Err((
                StatusCode::BAD_REQUEST,
                "Invalid channel name. Must be lowercase alphanumeric, periods, underscores, or dashes."
                    .to_string(),
            ));
        }
        existing.name = name;
    }
    if let Some(topic) = payload.topic {
        existing.topic = Some(topic);
    }
    if let Some(discoverability) = payload.discoverability {
        existing.discoverability = Some(discoverability);
    }
    if let Some(settings) = payload.settings {
        existing.settings = settings;
    }
    if let Some(tags) = payload.tags {
        existing.tags = tags;
    }

    let now = chrono::Utc::now().to_rfc3339();
    existing.updated_at = now.clone();

    let settings_json = serde_json::to_string(&existing.settings)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Serialization error: {}", e)))?;
    let tags_json = serde_json::to_string(&existing.tags)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Serialization error: {}", e)))?;
    let discoverability_str = existing
        .discoverability
        .as_ref()
        .map(|d| {
            serde_json::to_string(d)
                .unwrap_or_default()
                .trim_matches('"')
                .to_string()
        })
        .unwrap_or_default();

    state
        .db
        .update_document(
            "channels",
            &channel_doc.id,
            vec![
                ("name", existing.name.clone().into()),
                ("topic", existing.topic.as_deref().unwrap_or("").into()),
                ("discoverability", discoverability_str.into()),
                ("settings", settings_json.into()),
                ("tags", tags_json.into()),
                ("updated_at", now.into()),
            ],
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    Ok(Json(existing))
}

/// Get channel settings
pub async fn get_channel_settings(
    State(state): State<AppState>,
    Path((group_id, channel_id)): Path<(String, String)>,
    signed: SignedRequest,
) -> Result<Json<ChannelSettings>, (StatusCode, String)> {
    // Check membership
    let is_member = state
        .db
        .query("group_members")
        .filter(|f| f.eq("group_id", group_id.clone()) & f.eq("user_id", signed.user_id.clone()))
        .collect()
        .await
        .map(|docs| !docs.is_empty())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    if !is_member {
        return Err((StatusCode::FORBIDDEN, "Not a group member".to_string()));
    }

    let channel_doc = state
        .db
        .query("channels")
        .filter(|f| f.eq("id", channel_id.clone()) & f.eq("group_id", group_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?
        .into_iter()
        .next()
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Channel not found".to_string()))?;

    let settings: ChannelSettings = channel_doc
        .data
        .get("settings")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    Ok(Json(settings))
}

/// Update channel settings
pub async fn update_channel_settings(
    State(state): State<AppState>,
    Path((group_id, channel_id)): Path<(String, String)>,
    SignedJson {
        value: payload,
        user_id,
        ..
    }: SignedJson<UpdateChannelSettingsRequest>,
) -> Result<Json<ChannelSettings>, (StatusCode, String)> {
    // Check if user is owner or admin
    let member_doc = state
        .db
        .query("group_members")
        .filter(|f| f.eq("group_id", group_id.clone()) & f.eq("user_id", user_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?
        .into_iter()
        .next()
        .ok_or_else(|| (StatusCode::FORBIDDEN, "Not a group member".to_string()))?;

    let role = member_doc
        .data
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if role != "owner" && role != "admin" {
        return Err((
            StatusCode::FORBIDDEN,
            "Only owners and admins can update channel settings".to_string(),
        ));
    }

    // Get existing channel
    let channel_docs = state
        .db
        .query("channels")
        .filter(|f| f.eq("id", channel_id.clone()) & f.eq("group_id", group_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    let channel_doc = channel_docs
        .first()
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Channel not found".to_string()))?;

    let mut settings: ChannelSettings = channel_doc
        .data
        .get("settings")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    // Apply updates
    if let Some(permissions) = payload.permissions {
        settings.permissions = permissions;
    }
    if let Some(message_types) = payload.message_types {
        settings.message_types = message_types;
    }

    let now = chrono::Utc::now().to_rfc3339();
    let settings_json = serde_json::to_string(&settings)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Serialization error: {}", e)))?;

    state
        .db
        .update_document(
            "channels",
            &channel_doc.id,
            vec![("settings", settings_json.into()), ("updated_at", now.into())],
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    Ok(Json(settings))
}

/// Delete a channel (owner/admin only)
pub async fn delete_channel(
    State(state): State<AppState>,
    Path((group_id, channel_id)): Path<(String, String)>,
    signed: SignedRequest,
) -> Result<StatusCode, (StatusCode, String)> {
    // Check if user is owner or admin
    let member_doc = state
        .db
        .query("group_members")
        .filter(|f| f.eq("group_id", group_id.clone()) & f.eq("user_id", signed.user_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?
        .into_iter()
        .next()
        .ok_or_else(|| (StatusCode::FORBIDDEN, "Not a group member".to_string()))?;

    let role = member_doc
        .data
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if role != "owner" && role != "admin" {
        return Err((
            StatusCode::FORBIDDEN,
            "Only owners and admins can delete channels".to_string(),
        ));
    }

    // Get the channel
    let channel_doc = state
        .db
        .query("channels")
        .filter(|f| f.eq("id", channel_id.clone()) & f.eq("group_id", group_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?
        .into_iter()
        .next()
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Channel not found".to_string()))?;

    // Delete all messages in this channel
    let message_docs = state
        .db
        .query("messages")
        .filter(|f| f.eq("channel_id", channel_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    for msg_doc in message_docs {
        state
            .db
            .delete(&format!("messages:{}", msg_doc.id))
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;
    }

    // Delete the channel
    state
        .db
        .delete(&format!("channels:{}", channel_doc.id))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    Ok(StatusCode::NO_CONTENT)
}
