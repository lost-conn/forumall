#[cfg(feature = "server")]
use crate::server::middleware::cors::api_cors_layer;
use dioxus::logger::tracing;
use dioxus::prelude::ServerFnError;
use dioxus_fullstack::http::{Method, Uri};
use dioxus_fullstack::{get, post, put, HeaderMap, Json};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(default = "default_join_policy")]
    pub join_policy: String,
    pub owner: String,
    pub created_at: String,
    pub updated_at: String,
}

fn default_join_policy() -> String {
    "open".to_string()
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct Channel {
    pub id: String,
    pub group_id: String,
    pub name: String,
    pub topic: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CreateGroupRequest {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub join_policy: Option<String>,
}

#[post("/api/groups", headers: HeaderMap, method: Method, uri: Uri)]
#[middleware(api_cors_layer())]
pub async fn create_group(Json(payload): Json<CreateGroupRequest>) -> Result<Group, ServerFnError> {
    #[cfg(feature = "server")]
    let user_id = {
        let body_bytes =
            serde_json::to_vec(&payload).map_err(|e| ServerFnError::new(e.to_string()))?;
        let (uid, _) =
            crate::server::signature::verify_ofscp_signature(&method, &uri, &headers, &body_bytes)
                .await
                .map_err(|e| ServerFnError::new(format!("Signature error: {:?}", e)))?;
        uid
    };
    #[cfg(not(feature = "server"))]
    let user_id = "dev-user".to_string();

    // Use name as ID (enforce uniqueness)
    let id = payload.name.trim().to_string();
    if !crate::models::validate_resource_name(&id) {
        return Err(ServerFnError::new(
            "Invalid group name. Must be lowercase alphanumeric, periods, underscores, or dashes.",
        ));
    }

    let now = chrono::Utc::now().to_rfc3339();

    #[cfg(feature = "server")]
    {
        let db = &*crate::DB;
        let existing = db
            .query("groups")
            .filter(|f| f.eq("id", id.clone()))
            .collect()
            .await
            .map_err(|e| ServerFnError::new(format!("Database error: {}", e)))?;

        if !existing.is_empty() {
            return Err(ServerFnError::new("A group with this name already exists"));
        }
    }

    let group = Group {
        id: id.clone(),
        name: payload.name, // Name is same as ID
        description: payload.description,
        join_policy: payload.join_policy.unwrap_or_else(|| "open".to_string()),
        owner: user_id.clone(),
        created_at: now.clone(),
        updated_at: now.clone(),
    };

    #[cfg(feature = "server")]
    {
        let db = &*crate::DB;
        db.insert_into(
            "groups",
            vec![
                ("id", group.id.clone().into()),
                ("name", group.name.clone().into()),
                (
                    "description",
                    group.description.as_deref().unwrap_or("").into(),
                ),
                ("join_policy", group.join_policy.clone().into()),
                ("owner", group.owner.clone().into()),
                ("created_at", group.created_at.clone().into()),
                ("updated_at", group.updated_at.clone().into()),
            ],
        )
        .await
        .map_err(|e| {
            tracing::error!("Error inserting group: {:?}", e);
            ServerFnError::new(format!("Database error: {}", e))
        })?;

        db.insert_into(
            "group_members",
            vec![
                ("group_id", id.clone().into()),
                ("user_id", user_id.clone().into()),
                ("role", "owner".into()),
                ("created_at", now.clone().into()),
            ],
        )
        .await
        .map_err(|e| {
            tracing::error!("Error inserting group member: {:?}", e);
            ServerFnError::new(format!("Database error: {}", e))
        })?;

        db.insert_into(
            "user_joined_groups",
            vec![
                ("user_id", user_id.clone().into()),
                ("group_id", id.clone().into()),
                ("host", dioxus_fullstack::get_server_url().into()),
                ("name", group.name.clone().into()),
                ("joined_at", now.clone().into()),
            ],
        )
        .await
        .map_err(|e| {
            tracing::error!("Error inserting user_joined_groups: {:?}", e);
            ServerFnError::new(format!("Database error: {}", e))
        })?;
    }

    Ok(group)
}

#[get("/api/groups", headers: HeaderMap, method: Method, uri: Uri)]
#[middleware(api_cors_layer())]
pub async fn list_groups_for_user() -> Result<Vec<Group>, ServerFnError> {
    #[cfg(feature = "server")]
    let (user_id, _key_id) =
        crate::server::signature::verify_ofscp_signature(&method, &uri, &headers, &[])
            .await
            .map_err(|e| ServerFnError::new(format!("Signature error: {:?}", e)))?;
    #[cfg(not(feature = "server"))]
    let user_id = "dev-user".to_string();

    #[cfg(feature = "server")]
    {
        let db = &*crate::DB;

        let member_records = db
            .query("group_members")
            .filter(|f| f.eq("user_id", user_id.clone()))
            .collect()
            .await
            .map_err(|e| ServerFnError::new(format!("Database error: {}", e)))?;

        let group_ids: Vec<String> = member_records
            .into_iter()
            .filter_map(|m| {
                m.data
                    .get("group_id")
                    .and_then(|v: &aurora_db::Value| v.as_str())
                    .map(|s: &str| s.to_string())
            })
            .collect();

        let mut groups = Vec::new();
        for gid in group_ids {
            let matches = db
                .query("groups")
                .filter(|f| f.eq("id", gid.clone()))
                .collect()
                .await
                .map_err(|e| ServerFnError::new(format!("Database error: {}", e)))?;

            if let Some(doc) = matches.into_iter().next() {
                let id = doc
                    .data
                    .get("id")
                    .and_then(|v: &aurora_db::Value| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let name = doc
                    .data
                    .get("name")
                    .and_then(|v: &aurora_db::Value| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let description = doc
                    .data
                    .get("description")
                    .and_then(|v: &aurora_db::Value| v.as_str())
                    .map(|s: &str| s.to_string());
                let join_policy = doc
                    .data
                    .get("join_policy")
                    .and_then(|v: &aurora_db::Value| v.as_str())
                    .unwrap_or("open")
                    .to_string();
                let owner = doc
                    .data
                    .get("owner")
                    .and_then(|v: &aurora_db::Value| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let created_at = doc
                    .data
                    .get("created_at")
                    .and_then(|v: &aurora_db::Value| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let updated_at = doc
                    .data
                    .get("updated_at")
                    .and_then(|v: &aurora_db::Value| v.as_str())
                    .unwrap_or("")
                    .to_string();
                groups.push(Group {
                    id,
                    name,
                    description,
                    join_policy,
                    owner,
                    created_at,
                    updated_at,
                });
            }
        }

        groups.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(groups)
    }
    #[cfg(not(feature = "server"))]
    Ok(vec![])
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CreateChannelRequest {
    pub name: String,
    #[serde(default)]
    pub topic: Option<String>,
}

#[post("/api/groups/:group_id/channels", headers: HeaderMap, method: Method, uri: Uri)]
#[middleware(api_cors_layer())]
pub async fn create_channel(
    group_id: String,
    Json(payload): Json<CreateChannelRequest>,
) -> Result<Channel, ServerFnError> {
    #[cfg(feature = "server")]
    let user_id = {
        let body_bytes =
            serde_json::to_vec(&payload).map_err(|e| ServerFnError::new(e.to_string()))?;
        let (uid, _) =
            crate::server::signature::verify_ofscp_signature(&method, &uri, &headers, &body_bytes)
                .await
                .map_err(|e| ServerFnError::new(format!("Signature error: {:?}", e)))?;
        uid
    };
    #[cfg(not(feature = "server"))]
    let user_id = "dev-user".to_string();

    if !crate::models::validate_resource_name(&payload.name) {
        return Err(ServerFnError::new(
            "Invalid channel name. Must be lowercase alphanumeric, periods, underscores, or dashes.",
        ));
    }

    let channel_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    #[cfg(feature = "server")]
    {
        let db = &*crate::DB;

        // access control: must be a group member
        let is_member = db
            .query("group_members")
            .filter(|f| f.eq("group_id", group_id.clone()) & f.eq("user_id", user_id.clone()))
            .collect()
            .await
            .map(|docs| !docs.is_empty())
            .map_err(|e| ServerFnError::new(format!("Database error: {}", e)))?;

        if !is_member {
            return Err(ServerFnError::new("Unauthorized: Not a group member"));
        }

        let channel = Channel {
            id: channel_id,
            group_id: group_id.clone(),
            name: payload.name,
            topic: payload.topic,
            created_at: now.clone(),
            updated_at: now,
        };

        db.insert_into(
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
        .map_err(|e| ServerFnError::new(format!("Database error: {}", e)))?;

        Ok(channel)
    }
    #[cfg(not(feature = "server"))]
    Err(ServerFnError::new("Server feature not enabled"))
}

#[get("/api/groups/:group_id/channels", headers: HeaderMap, method: Method, uri: Uri)]
#[middleware(api_cors_layer())]
pub async fn list_channels(group_id: String) -> Result<Vec<Channel>, ServerFnError> {
    #[cfg(feature = "server")]
    let (user_id, _key_id) =
        crate::server::signature::verify_ofscp_signature(&method, &uri, &headers, &[])
            .await
            .map_err(|e| ServerFnError::new(format!("Signature error: {:?}", e)))?;
    #[cfg(not(feature = "server"))]
    let user_id = "dev-user".to_string();

    #[cfg(feature = "server")]
    {
        let db = &*crate::DB;

        // access control: must be a group member
        let is_member = db
            .query("group_members")
            .filter(|f| f.eq("group_id", group_id.clone()) & f.eq("user_id", user_id.clone()))
            .collect()
            .await
            .map(|docs| !docs.is_empty())
            .map_err(|e| ServerFnError::new(format!("Database error: {}", e)))?;

        if !is_member {
            return Err(ServerFnError::new("Unauthorized"));
        }

        let mut channels = db
            .query("channels")
            .filter(|f| f.eq("group_id", group_id.clone()))
            .collect()
            .await
            .map_err(|e| ServerFnError::new(format!("Database error: {}", e)))?
            .into_iter()
            .map(|doc| {
                let id = doc
                    .data
                    .get("id")
                    .and_then(|v: &aurora_db::Value| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let group_id = doc
                    .data
                    .get("group_id")
                    .and_then(|v: &aurora_db::Value| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let name = doc
                    .data
                    .get("name")
                    .and_then(|v: &aurora_db::Value| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let topic = doc
                    .data
                    .get("topic")
                    .and_then(|v: &aurora_db::Value| v.as_str())
                    .map(|s: &str| s.to_string());
                let created_at = doc
                    .data
                    .get("created_at")
                    .and_then(|v: &aurora_db::Value| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let updated_at = doc
                    .data
                    .get("updated_at")
                    .and_then(|v: &aurora_db::Value| v.as_str())
                    .unwrap_or("")
                    .to_string();
                Channel {
                    id,
                    group_id,
                    name,
                    topic,
                    created_at,
                    updated_at,
                }
            })
            .collect::<Vec<_>>();

        channels.sort_by(|a, b| a.created_at.cmp(&b.created_at));

        Ok(channels)
    }
    #[cfg(not(feature = "server"))]
    Ok(vec![])
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AddMemberRequest {
    pub handle: String,
}

#[post("/api/groups/:group_id/members", headers: HeaderMap, method: Method, uri: Uri)]
#[middleware(api_cors_layer())]
pub async fn add_group_member(
    group_id: String,
    Json(payload): Json<AddMemberRequest>,
) -> Result<(), ServerFnError> {
    #[cfg(feature = "server")]
    let user_id = {
        let body_bytes =
            serde_json::to_vec(&payload).map_err(|e| ServerFnError::new(e.to_string()))?;
        let (uid, _) =
            crate::server::signature::verify_ofscp_signature(&method, &uri, &headers, &body_bytes)
                .await
                .map_err(|e| ServerFnError::new(format!("Signature error: {:?}", e)))?;
        uid
    };
    #[cfg(not(feature = "server"))]
    let user_id = "dev-user".to_string();

    let now = chrono::Utc::now().to_rfc3339();

    let db = &*crate::DB;

    // 1. Verify requester is the owner of the group
    let group_docs = db
        .query("groups")
        .filter(|f| f.eq("id", group_id.clone()) & f.eq("owner", user_id.clone()))
        .collect()
        .await
        .map_err(|e| ServerFnError::new(format!("Database error checking ownership: {}", e)))?;

    if group_docs.is_empty() {
        return Err(ServerFnError::new(
            "Unauthorized: Only the group owner can add members",
        ));
    }

    // 2. Resolve the target user by handle
    // Note: This assumes the handle is unique or we are looking for a local user.
    // TODO: Handle domains for federation if needed.
    let user_docs = db
        .query("users")
        .filter(|f| f.eq("handle", payload.handle.clone()))
        .collect()
        .await
        .map_err(|e| ServerFnError::new(format!("Database error resolving user: {}", e)))?;

    let target_user_doc = user_docs
        .first()
        .ok_or_else(|| ServerFnError::new(format!("User '{}' not found", payload.handle)))?;

    let target_user_id = target_user_doc
        .data
        .get("handle")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ServerFnError::new("Invalid user data"))?
        .to_string();

    // 3. Check if user is already a member
    let member_docs = db
        .query("group_members")
        .filter(|f| f.eq("group_id", group_id.clone()) & f.eq("user_id", target_user_id.clone()))
        .collect()
        .await
        .map_err(|e| ServerFnError::new(format!("Database error checking membership: {}", e)))?;

    if !member_docs.is_empty() {
        return Err(ServerFnError::new(format!(
            "User '{}' is already a member of this group",
            payload.handle
        )));
    }

    // 4. Add the user to the group
    db.insert_into(
        "group_members",
        vec![
            ("group_id", group_id.clone().into()),
            ("user_id", target_user_id.clone().into()),
            ("role", "member".into()),
            ("created_at", now.clone().into()),
        ],
    )
    .await
    .map_err(|e| ServerFnError::new(format!("Database error adding member: {}", e)))?;

    // 5. Add to user_joined_groups
    // We need the group name for this. We already fetched the group in step 1.
    let group_name = group_docs[0]
        .data
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown Group")
        .to_string();

    db.insert_into(
        "user_joined_groups",
        vec![
            ("user_id", target_user_id.into()),
            ("group_id", group_id.into()),
            ("host", dioxus_fullstack::get_server_url().into()),
            ("name", group_name.into()),
            ("joined_at", now.into()),
        ],
    )
    .await
    .map_err(|e| ServerFnError::new(format!("Database error updating joined groups: {}", e)))?;

    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct UpdateGroupSettingsRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub join_policy: Option<String>,
}

#[put("/api/groups/:group_id", headers: HeaderMap, method: Method, uri: Uri)]
#[middleware(api_cors_layer())]
pub async fn update_group_settings(
    group_id: String,
    Json(payload): Json<UpdateGroupSettingsRequest>,
) -> Result<(), ServerFnError> {
    #[cfg(feature = "server")]
    let user_id = {
        let body_bytes =
            serde_json::to_vec(&payload).map_err(|e| ServerFnError::new(e.to_string()))?;
        let (uid, _) =
            crate::server::signature::verify_ofscp_signature(&method, &uri, &headers, &body_bytes)
                .await
                .map_err(|e| ServerFnError::new(format!("Signature error: {:?}", e)))?;
        uid
    };
    #[cfg(not(feature = "server"))]
    let user_id = "dev-user".to_string();

    let db = &*crate::DB;

    // 1. Verify ownership
    let group_docs = db
        .query("groups")
        .filter(|f| f.eq("id", group_id.clone()) & f.eq("owner", user_id.clone()))
        .collect()
        .await
        .map_err(|e| ServerFnError::new(format!("Database error checking ownership: {}", e)))?;

    if group_docs.is_empty() {
        return Err(ServerFnError::new(
            "Unauthorized: Only the group owner can update settings",
        ));
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

    db.update_document("groups", &existing_doc.id, data)
        .await
        .map_err(|e| ServerFnError::new(format!("Database error updating group: {}", e)))?;

    Ok(())
}

#[post("/api/groups/:group_id/join", headers: HeaderMap, method: Method, uri: Uri)]
#[middleware(api_cors_layer())]
pub async fn join_group(group_id: String) -> Result<(), ServerFnError> {
    #[cfg(feature = "server")]
    let (user_id, _key_id) =
        crate::server::signature::verify_ofscp_signature(&method, &uri, &headers, &[])
            .await
            .map_err(|e| ServerFnError::new(format!("Signature error: {:?}", e)))?;
    #[cfg(not(feature = "server"))]
    let user_id = "dev-user".to_string();

    let now = chrono::Utc::now().to_rfc3339();

    let db = &*crate::DB;

    // 1. Check if user is already a member
    let member_docs = db
        .query("group_members")
        .filter(|f| f.eq("group_id", group_id.clone()) & f.eq("user_id", user_id.clone()))
        .collect()
        .await
        .map_err(|e| ServerFnError::new(format!("Database error: {}", e)))?;

    if !member_docs.is_empty() {
        // Already a member. Just ensure it's in user_joined_groups and return success.
        // (Idempotency)
    } else {
        // 2. Fetch Group to check policy
        let group_docs = db
            .query("groups")
            .filter(|f| f.eq("id", group_id.clone()))
            .collect()
            .await
            .map_err(|e| ServerFnError::new(format!("Database error: {}", e)))?;

        let group_doc = group_docs
            .first()
            .ok_or_else(|| ServerFnError::new("Group not found"))?;

        let join_policy = group_doc
            .data
            .get("join_policy")
            .and_then(|v| v.as_str())
            .unwrap_or("open");

        if join_policy != "open" {
            return Err(ServerFnError::new("Group is not open for joining"));
        }

        // 3. Add to group_members
        db.insert_into(
            "group_members",
            vec![
                ("group_id", group_id.clone().into()),
                ("user_id", user_id.clone().into()),
                ("role", "member".into()),
                ("created_at", now.clone().into()),
            ],
        )
        .await
        .map_err(|e| ServerFnError::new(format!("Database error adding member: {}", e)))?;
    }

    // 4. Update user_joined_groups (upsert-ish)
    // We need the name
    let group_docs = db
        .query("groups")
        .filter(|f| f.eq("id", group_id.clone()))
        .collect()
        .await
        .unwrap(); // Should be there
    let group_name = group_docs
        .first()
        .and_then(|d| d.data.get("name").and_then(|v| v.as_str()))
        .unwrap_or("Unknown")
        .to_string();

    db.insert_into(
        "user_joined_groups",
        vec![
            ("user_id", user_id.clone().into()),
            ("group_id", group_id.clone().into()),
            ("host", dioxus_fullstack::get_server_url().into()),
            ("name", group_name.into()),
            ("joined_at", now.into()),
        ],
    )
    .await
    .map_err(|e| ServerFnError::new(format!("Database error: {}", e)))?;

    Ok(())
}
