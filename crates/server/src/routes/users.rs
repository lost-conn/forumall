//! User routes.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use forumall_shared::{
    AddJoinedGroupRequest, Availability, Presence, PrivacySettings, UpdatePresenceRequest,
    UpdateProfileRequest, UserJoinedGroup, UserProfile, VisibilityPolicy,
};

use crate::middleware::signature::{OptionalSignedRequest, SignedJson, SignedRequest};
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

    let default_host = state.domain();
    let groups = state.db
        .query("user_joined_groups")
        .filter(|f| f.eq("user_id", user_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?
        .into_iter()
        .map(|doc| {
            let host = doc.data.get("host")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .or_else(|| Some(default_host.clone()));
            UserJoinedGroup {
                group_id: doc.data.get("group_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                host,
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
    let display_name = user_doc.data.get("display_name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
    let avatar = user_doc.data.get("avatar").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
    let bio = user_doc.data.get("bio").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
    let updated_at_str = user_doc.data.get("updated_at").and_then(|v| v.as_str()).unwrap_or("");

    let metadata = user_doc.data.get("metadata")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    let updated_at = chrono::DateTime::parse_from_rfc3339(updated_at_str)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .unwrap_or_else(|_| chrono::Utc::now());

    Ok(Json(UserProfile {
        handle,
        domain,
        display_name,
        avatar,
        bio,
        updated_at,
        metadata,
    }))
}

/// Update current user's profile (PATCH /api/me/profile)
pub async fn update_profile(
    State(state): State<AppState>,
    SignedJson { value: payload, user_id, .. }: SignedJson<UpdateProfileRequest>,
) -> Result<Json<UserProfile>, (StatusCode, String)> {
    // user_id is in format "handle@domain", extract handle
    let handle = user_id.split('@').next().unwrap_or(&user_id).to_string();

    // Find existing user
    let user_docs: Vec<_> = state.db
        .query("users")
        .filter(|f| f.eq("handle", handle.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?;

    let user_doc = user_docs
        .into_iter()
        .next()
        .ok_or_else(|| (StatusCode::NOT_FOUND, "User not found".to_string()))?;

    let now = chrono::Utc::now();

    // Get current values
    let current_display_name = user_doc.data.get("display_name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
    let current_avatar = user_doc.data.get("avatar").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
    let current_bio = user_doc.data.get("bio").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
    let current_metadata: Vec<forumall_shared::MetadataItem> = user_doc.data.get("metadata")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();
    let domain = user_doc.data.get("domain").and_then(|v| v.as_str()).unwrap_or("").to_string();

    // Apply updates
    let new_display_name = payload.display_name.or(current_display_name);
    let new_avatar = payload.avatar.or(current_avatar);
    let new_bio = payload.bio.or(current_bio);
    let new_metadata = payload.metadata.unwrap_or(current_metadata);

    // Update user document
    state.db
        .update_document("users", &user_doc.id, vec![
                ("display_name", new_display_name.clone().unwrap_or_default().into()),
                ("avatar", new_avatar.clone().unwrap_or_default().into()),
                ("bio", new_bio.clone().unwrap_or_default().into()),
                ("metadata", serde_json::to_string(&new_metadata).unwrap_or_default().into()),
                ("updated_at", now.to_rfc3339().into()),
            ],
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?;

    Ok(Json(UserProfile {
        handle,
        domain,
        display_name: new_display_name,
        avatar: new_avatar,
        bio: new_bio,
        updated_at: now,
        metadata: new_metadata,
    }))
}

/// Get current user's presence (GET /api/me/presence)
pub async fn get_own_presence(
    State(state): State<AppState>,
    signed: SignedRequest,
) -> Result<Json<Presence>, (StatusCode, String)> {
    let handle = signed.user_id.split('@').next().unwrap_or(&signed.user_id).to_string();
    get_presence_for_user(&state, &handle).await.map(Json)
}

/// Update current user's presence (PUT /api/me/presence)
pub async fn update_presence(
    State(state): State<AppState>,
    SignedJson { value: payload, user_id, .. }: SignedJson<UpdatePresenceRequest>,
) -> Result<Json<Presence>, (StatusCode, String)> {
    let handle = user_id.split('@').next().unwrap_or(&user_id).to_string();
    let now = chrono::Utc::now();

    let availability_str = match payload.availability {
        Availability::Online => "online",
        Availability::Away => "away",
        Availability::Dnd => "dnd",
        Availability::Offline => "offline",
    };

    // Check if presence record exists
    let existing: Vec<_> = state.db
        .query("presence")
        .filter(|f| f.eq("user_handle", handle.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?;

    if let Some(doc) = existing.into_iter().next() {
        // Update existing
        state.db
            .update_document("presence", &doc.id, vec![
                ("availability", availability_str.into()),
                ("status", payload.status.clone().unwrap_or_default().into()),
                ("last_seen", now.to_rfc3339().into()),
                ("updated_at", now.to_rfc3339().into()),
            ])
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?;
    } else {
        // Insert new
        state.db
            .insert_into(
                "presence",
                vec![
                    ("user_handle", handle.clone().into()),
                    ("availability", availability_str.into()),
                    ("status", payload.status.clone().unwrap_or_default().into()),
                    ("last_seen", now.to_rfc3339().into()),
                    ("metadata", "[]".into()),
                    ("updated_at", now.to_rfc3339().into()),
                ],
            )
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?;
    }

    Ok(Json(Presence {
        availability: payload.availability,
        status: payload.status,
        last_seen: Some(now),
        metadata: vec![],
    }))
}

/// Get another user's presence (GET /api/users/{handle}/presence)
/// Respects privacy settings
pub async fn get_user_presence(
    State(state): State<AppState>,
    Path(handle): Path<String>,
    OptionalSignedRequest(signed): OptionalSignedRequest,
) -> Result<Json<Presence>, (StatusCode, String)> {
    // Get target user's privacy settings
    let privacy = get_privacy_for_user(&state, &handle).await?;

    // Check if requester can see presence
    let requester_handle = signed.as_ref().map(|s| s.user_id.split('@').next().unwrap_or(&s.user_id).to_string());

    let can_view = match privacy.presence_visibility {
        VisibilityPolicy::Public => true,
        VisibilityPolicy::Authenticated => requester_handle.is_some(),
        VisibilityPolicy::SharedGroups => {
            if let Some(ref req_handle) = requester_handle {
                shares_group(&state, &handle, req_handle).await.unwrap_or(false)
            } else {
                false
            }
        }
        VisibilityPolicy::Contacts => false, // Not implemented yet
        VisibilityPolicy::Nobody => false,
    };

    if !can_view {
        return Err((StatusCode::FORBIDDEN, "Presence not visible".to_string()));
    }

    get_presence_for_user(&state, &handle).await.map(Json)
}

/// Get current user's privacy settings (GET /api/me/privacy)
pub async fn get_privacy_settings(
    State(state): State<AppState>,
    signed: SignedRequest,
) -> Result<Json<PrivacySettings>, (StatusCode, String)> {
    let handle = signed.user_id.split('@').next().unwrap_or(&signed.user_id).to_string();
    get_privacy_for_user(&state, &handle).await.map(Json)
}

/// Update current user's privacy settings (PUT /api/me/privacy)
pub async fn update_privacy_settings(
    State(state): State<AppState>,
    SignedJson { value: payload, user_id, .. }: SignedJson<PrivacySettings>,
) -> Result<Json<PrivacySettings>, (StatusCode, String)> {
    let handle = user_id.split('@').next().unwrap_or(&user_id).to_string();
    let now = chrono::Utc::now();

    let presence_vis = visibility_to_str(&payload.presence_visibility);
    let profile_vis = visibility_to_str(&payload.profile_visibility);
    let membership_vis = visibility_to_str(&payload.membership_visibility);

    // Check if privacy record exists
    let existing: Vec<_> = state.db
        .query("privacy_settings")
        .filter(|f| f.eq("user_handle", handle.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?;

    if let Some(doc) = existing.into_iter().next() {
        state.db
            .update_document("privacy_settings", &doc.id, vec![
                ("presence_visibility", presence_vis.into()),
                ("profile_visibility", profile_vis.into()),
                ("membership_visibility", membership_vis.into()),
                ("updated_at", now.to_rfc3339().into()),
            ])
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?;
    } else {
        state.db
            .insert_into(
                "privacy_settings",
                vec![
                    ("user_handle", handle.into()),
                    ("presence_visibility", presence_vis.into()),
                    ("profile_visibility", profile_vis.into()),
                    ("membership_visibility", membership_vis.into()),
                    ("updated_at", now.to_rfc3339().into()),
                ],
            )
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?;
    }

    Ok(Json(payload))
}

// Helper functions

async fn get_presence_for_user(state: &AppState, handle: &str) -> Result<Presence, (StatusCode, String)> {
    let docs: Vec<_> = state.db
        .query("presence")
        .filter(|f| f.eq("user_handle", handle.to_string()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?;

    if let Some(doc) = docs.into_iter().next() {
        let availability_str = doc.data.get("availability").and_then(|v| v.as_str()).unwrap_or("offline");
        let availability = match availability_str {
            "online" => Availability::Online,
            "away" => Availability::Away,
            "dnd" => Availability::Dnd,
            _ => Availability::Offline,
        };

        let status = doc.data.get("status").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
        let last_seen_str = doc.data.get("last_seen").and_then(|v| v.as_str()).unwrap_or("");
        let last_seen = chrono::DateTime::parse_from_rfc3339(last_seen_str)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .ok();

        let metadata = doc.data.get("metadata")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();

        Ok(Presence {
            availability,
            status,
            last_seen,
            metadata,
        })
    } else {
        Ok(Presence::default())
    }
}

async fn get_privacy_for_user(state: &AppState, handle: &str) -> Result<PrivacySettings, (StatusCode, String)> {
    let docs: Vec<_> = state.db
        .query("privacy_settings")
        .filter(|f| f.eq("user_handle", handle.to_string()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?;

    if let Some(doc) = docs.into_iter().next() {
        let presence_vis = doc.data.get("presence_visibility").and_then(|v| v.as_str()).unwrap_or("public");
        let profile_vis = doc.data.get("profile_visibility").and_then(|v| v.as_str()).unwrap_or("public");
        let membership_vis = doc.data.get("membership_visibility").and_then(|v| v.as_str()).unwrap_or("public");

        Ok(PrivacySettings {
            presence_visibility: str_to_visibility(presence_vis),
            profile_visibility: str_to_visibility(profile_vis),
            membership_visibility: str_to_visibility(membership_vis),
        })
    } else {
        Ok(PrivacySettings::default())
    }
}

fn visibility_to_str(v: &VisibilityPolicy) -> &'static str {
    match v {
        VisibilityPolicy::Public => "public",
        VisibilityPolicy::Authenticated => "authenticated",
        VisibilityPolicy::SharedGroups => "sharedGroups",
        VisibilityPolicy::Contacts => "contacts",
        VisibilityPolicy::Nobody => "nobody",
    }
}

fn str_to_visibility(s: &str) -> VisibilityPolicy {
    match s {
        "authenticated" => VisibilityPolicy::Authenticated,
        "sharedGroups" => VisibilityPolicy::SharedGroups,
        "contacts" => VisibilityPolicy::Contacts,
        "nobody" => VisibilityPolicy::Nobody,
        _ => VisibilityPolicy::Public,
    }
}

/// Check if two users share at least one group
async fn shares_group(state: &AppState, user1: &str, user2: &str) -> Result<bool, (StatusCode, String)> {
    // Get groups for user1
    let user1_groups: Vec<_> = state.db
        .query("group_members")
        .filter(|f| f.eq("user_id", user1.to_string()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?;

    let user1_group_ids: std::collections::HashSet<String> = user1_groups
        .iter()
        .filter_map(|doc| doc.data.get("group_id").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();

    // Get groups for user2
    let user2_groups: Vec<_> = state.db
        .query("group_members")
        .filter(|f| f.eq("user_id", user2.to_string()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?;

    for doc in user2_groups {
        if let Some(group_id) = doc.data.get("group_id").and_then(|v| v.as_str()) {
            if user1_group_ids.contains(group_id) {
                return Ok(true);
            }
        }
    }

    Ok(false)
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
    let host = payload.host.clone()
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| state.domain());

    // Check for existing entry with same user_id + group_id
    let existing = state.db
        .query("user_joined_groups")
        .filter(|f| f.eq("user_id", user_id.clone()) & f.eq("group_id", payload.group_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    // Delete existing entry if found (we'll re-insert with updated values)
    let joined_at = if let Some(doc) = existing.into_iter().next() {
        let original_joined_at = doc.data.get("joined_at").and_then(|v| v.as_str()).unwrap_or(&now).to_string();
        state.db
            .delete(&format!("user_joined_groups:{}", doc.id))
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;
        original_joined_at
    } else {
        now.clone()
    };

    // Insert entry (new or replacement)
    state.db
        .insert_into(
            "user_joined_groups",
            vec![
                ("user_id", user_id.into()),
                ("group_id", payload.group_id.clone().into()),
                ("host", host.clone().into()),
                ("name", payload.name.clone().into()),
                ("joined_at", joined_at.clone().into()),
            ],
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    Ok(Json(UserJoinedGroup {
        group_id: payload.group_id,
        host: Some(host),
        name: payload.name,
        joined_at,
    }))
}

/// Add a joined group for the current user (/api/me/groups)
pub async fn add_self_joined_group(
    State(state): State<AppState>,
    SignedJson { value: payload, user_id, .. }: SignedJson<AddJoinedGroupRequest>,
) -> Result<Json<UserJoinedGroup>, (StatusCode, String)> {
    let now = chrono::Utc::now().to_rfc3339();
    let host = payload.host.clone()
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| state.domain());

    // Check for existing entry with same user_id + group_id
    let existing = state.db
        .query("user_joined_groups")
        .filter(|f| f.eq("user_id", user_id.clone()) & f.eq("group_id", payload.group_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    // Delete existing entry if found (we'll re-insert with updated values)
    let joined_at = if let Some(doc) = existing.into_iter().next() {
        let original_joined_at = doc.data.get("joined_at").and_then(|v| v.as_str()).unwrap_or(&now).to_string();
        state.db
            .delete(&format!("user_joined_groups:{}", doc.id))
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;
        original_joined_at
    } else {
        now.clone()
    };

    // Insert entry (new or replacement)
    state.db
        .insert_into(
            "user_joined_groups",
            vec![
                ("user_id", user_id.into()),
                ("group_id", payload.group_id.clone().into()),
                ("host", host.clone().into()),
                ("name", payload.name.clone().into()),
                ("joined_at", joined_at.clone().into()),
            ],
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {}", e)))?;

    Ok(Json(UserJoinedGroup {
        group_id: payload.group_id,
        host: Some(host),
        name: payload.name,
        joined_at,
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
