//! Group management routes.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use forumall_shared::{AddMemberRequest, CreateGroupRequest, Group, UpdateGroupSettingsRequest};

use crate::middleware::signature::{SignedJson, SignedRequest};
use crate::state::AppState;

/// Create a new group
pub async fn create_group(
    State(state): State<AppState>,
    SignedJson { value: payload, user_id, .. }: SignedJson<CreateGroupRequest>,
) -> Result<Json<Group>, (StatusCode, String)> {
    let id = payload.name.trim().to_string();

    if !forumall_shared::validate_resource_name(&id) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Invalid group name. Must be lowercase alphanumeric, periods, underscores, or dashes.".to_string(),
        ));
    }

    // Check for existing group
    let existing = state.db
        .query("groups")
        .filter(|f| f.eq("id", id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    if !existing.is_empty() {
        return Err((StatusCode::CONFLICT, "A group with this name already exists".to_string()));
    }

    let now = chrono::Utc::now().to_rfc3339();

    let group = Group {
        id: id.clone(),
        name: payload.name,
        description: payload.description,
        join_policy: payload.join_policy.unwrap_or_else(|| "open".to_string()),
        owner: user_id.clone(),
        created_at: now.clone(),
        updated_at: now.clone(),
    };

    // Insert group
    state.db
        .insert_into(
            "groups",
            vec![
                ("id", group.id.clone().into()),
                ("name", group.name.clone().into()),
                ("description", group.description.as_deref().unwrap_or("").into()),
                ("join_policy", group.join_policy.clone().into()),
                ("owner", group.owner.clone().into()),
                ("created_at", group.created_at.clone().into()),
                ("updated_at", group.updated_at.clone().into()),
            ],
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    // Add owner as member
    state.db
        .insert_into(
            "group_members",
            vec![
                ("group_id", id.clone().into()),
                ("user_id", user_id.clone().into()),
                ("role", "owner".into()),
                ("created_at", now.clone().into()),
            ],
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    // Add to user_joined_groups
    state.db
        .insert_into(
            "user_joined_groups",
            vec![
                ("user_id", user_id.into()),
                ("group_id", id.into()),
                ("name", group.name.clone().into()),
                ("joined_at", now.into()),
            ],
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    Ok(Json(group))
}

/// List groups for the authenticated user
pub async fn list_groups(
    State(state): State<AppState>,
    signed: SignedRequest,
) -> Result<Json<Vec<Group>>, (StatusCode, String)> {
    let member_records = state.db
        .query("group_members")
        .filter(|f| f.eq("user_id", signed.user_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    let group_ids: Vec<String> = member_records
        .into_iter()
        .filter_map(|m| m.data.get("group_id").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();

    let mut groups = Vec::new();
    for gid in group_ids {
        let matches = state.db
            .query("groups")
            .filter(|f| f.eq("id", gid.clone()))
            .collect()
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

        if let Some(doc) = matches.into_iter().next() {
            groups.push(Group {
                id: doc.data.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                name: doc.data.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                description: doc.data.get("description").and_then(|v| v.as_str()).map(|s| s.to_string()),
                join_policy: doc.data.get("join_policy").and_then(|v| v.as_str()).unwrap_or("open").to_string(),
                owner: doc.data.get("owner").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                created_at: doc.data.get("created_at").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                updated_at: doc.data.get("updated_at").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            });
        }
    }

    groups.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(Json(groups))
}

/// Get a single group by ID
pub async fn get_group(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
) -> Result<Json<Group>, (StatusCode, String)> {
    let matches = state.db
        .query("groups")
        .filter(|f| f.eq("id", group_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    let doc = matches
        .into_iter()
        .next()
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Group not found".to_string()))?;

    Ok(Json(Group {
        id: doc.data.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        name: doc.data.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        description: doc.data.get("description").and_then(|v| v.as_str()).map(|s| s.to_string()),
        join_policy: doc.data.get("join_policy").and_then(|v| v.as_str()).unwrap_or("open").to_string(),
        owner: doc.data.get("owner").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        created_at: doc.data.get("created_at").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        updated_at: doc.data.get("updated_at").and_then(|v| v.as_str()).unwrap_or("").to_string(),
    }))
}

/// Update group settings (owner only)
pub async fn update_group(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    SignedJson { value: payload, user_id, .. }: SignedJson<UpdateGroupSettingsRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    // Verify ownership
    let group_docs = state.db
        .query("groups")
        .filter(|f| f.eq("id", group_id.clone()) & f.eq("owner", user_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    if group_docs.is_empty() {
        return Err((StatusCode::FORBIDDEN, "Only the group owner can update settings".to_string()));
    }

    let existing_doc = &group_docs[0];
    let mut data = Vec::<(&str, aurora_db::Value)>::new();

    if let Some(name) = payload.name {
        data.push(("name", name.into()));
    }
    if let Some(desc) = payload.description {
        data.push(("description", desc.into()));
    }
    if let Some(policy) = payload.join_policy {
        data.push(("join_policy", policy.into()));
    }

    if !data.is_empty() {
        state.db
            .update_document("groups", &existing_doc.id, data)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;
    }

    Ok(StatusCode::NO_CONTENT)
}

/// Join a group
pub async fn join_group(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    SignedJson { user_id, .. }: SignedJson<()>,
) -> Result<StatusCode, (StatusCode, String)> {
    let now = chrono::Utc::now().to_rfc3339();

    // Check if already a member
    let member_docs = state.db
        .query("group_members")
        .filter(|f| f.eq("group_id", group_id.clone()) & f.eq("user_id", user_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    if member_docs.is_empty() {
        // Check group join policy
        let group_docs = state.db
            .query("groups")
            .filter(|f| f.eq("id", group_id.clone()))
            .collect()
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

        let group_doc = group_docs
            .first()
            .ok_or_else(|| (StatusCode::NOT_FOUND, "Group not found".to_string()))?;

        let join_policy = group_doc.data.get("join_policy").and_then(|v| v.as_str()).unwrap_or("open");

        if join_policy != "open" {
            return Err((StatusCode::FORBIDDEN, "Group is not open for joining".to_string()));
        }

        // Add to group_members
        state.db
            .insert_into(
                "group_members",
                vec![
                    ("group_id", group_id.clone().into()),
                    ("user_id", user_id.clone().into()),
                    ("role", "member".into()),
                    ("created_at", now.clone().into()),
                ],
            )
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;
    }

    // Check if already in user_joined_groups
    let joined_docs = state.db
        .query("user_joined_groups")
        .filter(|f| f.eq("user_id", user_id.clone()) & f.eq("group_id", group_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    // Only add to user_joined_groups if not already there
    if joined_docs.is_empty() {
        let group_docs = state.db
            .query("groups")
            .filter(|f| f.eq("id", group_id.clone()))
            .collect()
            .await
            .unwrap_or_default();

        let group_name = group_docs
            .first()
            .and_then(|d| d.data.get("name").and_then(|v| v.as_str()))
            .unwrap_or("Unknown")
            .to_string();

        state.db
            .insert_into(
                "user_joined_groups",
                vec![
                    ("user_id", user_id.into()),
                    ("group_id", group_id.into()),
                    ("name", group_name.into()),
                    ("joined_at", now.into()),
                ],
            )
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;
    }

    Ok(StatusCode::NO_CONTENT)
}

/// Leave a group (members only, not owner)
pub async fn leave_group(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    SignedJson { user_id, .. }: SignedJson<()>,
) -> Result<StatusCode, (StatusCode, String)> {
    // Check if user is a member
    let member_docs = state.db
        .query("group_members")
        .filter(|f| f.eq("group_id", group_id.clone()) & f.eq("user_id", user_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    let member_doc = member_docs
        .first()
        .ok_or_else(|| (StatusCode::NOT_FOUND, "You are not a member of this group".to_string()))?;

    // Check if user is the owner
    let role = member_doc.data
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if role == "owner" {
        return Err((StatusCode::FORBIDDEN, "Group owner cannot leave. Delete the group instead.".to_string()));
    }

    // Remove from group_members
    state.db
        .delete(&format!("group_members:{}", member_doc.id))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    // Remove from user_joined_groups
    let joined_docs = state.db
        .query("user_joined_groups")
        .filter(|f| f.eq("user_id", user_id.clone()) & f.eq("group_id", group_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    for doc in joined_docs {
        state.db
            .delete(&format!("user_joined_groups:{}", doc.id))
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;
    }

    Ok(StatusCode::NO_CONTENT)
}

/// Delete a group (owner only)
pub async fn delete_group(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    signed: SignedRequest,
) -> Result<StatusCode, (StatusCode, String)> {
    // Verify ownership
    let group_docs = state.db
        .query("groups")
        .filter(|f| f.eq("id", group_id.clone()) & f.eq("owner", signed.user_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    let group_doc = group_docs
        .first()
        .ok_or_else(|| (StatusCode::FORBIDDEN, "Only the group owner can delete this group".to_string()))?;

    // Delete all messages in all channels of this group
    let channel_docs = state.db
        .query("channels")
        .filter(|f| f.eq("group_id", group_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    for channel_doc in &channel_docs {
        let channel_id = channel_doc.data
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        // Delete messages in this channel
        let message_docs = state.db
            .query("messages")
            .filter(|f| f.eq("channel_id", channel_id.to_string()))
            .collect()
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

        for msg_doc in message_docs {
            state.db
                .delete(&format!("messages:{}", msg_doc.id))
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;
        }

        // Delete the channel
        state.db
            .delete(&format!("channels:{}", channel_doc.id))
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;
    }

    // Delete all group_members
    let member_docs = state.db
        .query("group_members")
        .filter(|f| f.eq("group_id", group_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    for doc in member_docs {
        state.db
            .delete(&format!("group_members:{}", doc.id))
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;
    }

    // Delete all user_joined_groups entries for this group
    let joined_docs = state.db
        .query("user_joined_groups")
        .filter(|f| f.eq("group_id", group_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    for doc in joined_docs {
        state.db
            .delete(&format!("user_joined_groups:{}", doc.id))
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;
    }

    // Delete the group itself
    state.db
        .delete(&format!("groups:{}", group_doc.id))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    Ok(StatusCode::NO_CONTENT)
}

/// Add a member to a group (owner only)
pub async fn add_member(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    SignedJson { value: payload, user_id, .. }: SignedJson<AddMemberRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let now = chrono::Utc::now().to_rfc3339();

    // Verify requester is owner
    let group_docs = state.db
        .query("groups")
        .filter(|f| f.eq("id", group_id.clone()) & f.eq("owner", user_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    if group_docs.is_empty() {
        return Err((StatusCode::FORBIDDEN, "Only the group owner can add members".to_string()));
    }

    // Find target user
    let user_docs = state.db
        .query("users")
        .filter(|f| f.eq("handle", payload.handle.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    let target_user_doc = user_docs
        .first()
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("User '{}' not found", payload.handle)))?;

    let target_user_id = target_user_doc.data
        .get("handle")
        .and_then(|v| v.as_str())
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, "Invalid user data".to_string()))?
        .to_string();

    // Check if already a member
    let member_docs = state.db
        .query("group_members")
        .filter(|f| f.eq("group_id", group_id.clone()) & f.eq("user_id", target_user_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    if !member_docs.is_empty() {
        return Err((StatusCode::CONFLICT, format!("User '{}' is already a member", payload.handle)));
    }

    // Add member
    state.db
        .insert_into(
            "group_members",
            vec![
                ("group_id", group_id.clone().into()),
                ("user_id", target_user_id.clone().into()),
                ("role", "member".into()),
                ("created_at", now.clone().into()),
            ],
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    // Add to user_joined_groups
    let group_name = group_docs[0].data
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown Group")
        .to_string();

    state.db
        .insert_into(
            "user_joined_groups",
            vec![
                ("user_id", target_user_id.into()),
                ("group_id", group_id.into()),
                ("name", group_name.into()),
                ("joined_at", now.into()),
            ],
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    Ok(StatusCode::NO_CONTENT)
}
