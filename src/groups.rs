#[cfg(feature = "server")]
use crate::server::auth;
use dioxus::logger::tracing;
use dioxus::prelude::ServerFnError;
use dioxus_fullstack::{get, post, HeaderMap, Json};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub owner_user_id: String,
    pub created_at: String,
    pub updated_at: String,
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
}

#[post("/api/groups", headers: HeaderMap)]
pub async fn create_group(
    Json(payload): Json<CreateGroupRequest>,
) -> Result<Json<Group>, ServerFnError> {
    let user_id = auth::require_bearer_user_id(&headers)?.user_id;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    let group = Group {
        id: id.clone(),
        name: payload.name,
        description: payload.description,
        owner_user_id: user_id.clone(),
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
                ("owner_user_id", group.owner_user_id.clone().into()),
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
                ("group_id", id.into()),
                ("user_id", user_id.into()),
                ("role", "owner".into()),
                ("created_at", now.into()),
            ],
        )
        .await
        .map_err(|e| {
            tracing::error!("Error inserting group member: {:?}", e);
            ServerFnError::new(format!("Database error: {}", e))
        })?;
    }

    Ok(Json(group))
}

#[get("/api/groups", headers: HeaderMap)]
pub async fn list_groups_for_user() -> Result<Json<Vec<Group>>, ServerFnError> {
    let user_id = crate::server::auth::require_bearer_user_id(&headers)?.user_id;

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
                let owner_user_id = doc
                    .data
                    .get("owner_user_id")
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
                    owner_user_id,
                    created_at,
                    updated_at,
                });
            }
        }

        groups.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(Json(groups))
    }
    #[cfg(not(feature = "server"))]
    Ok(Json(vec![]))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CreateChannelRequest {
    pub name: String,
    #[serde(default)]
    pub topic: Option<String>,
}

#[post("/api/groups/:group_id/channels", headers: HeaderMap)]
pub async fn create_channel(
    group_id: String,
    Json(payload): Json<CreateChannelRequest>,
) -> Result<Json<Channel>, ServerFnError> {
    let user_id = crate::server::auth::require_bearer_user_id(&headers)?.user_id;

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

        Ok(Json(channel))
    }
    #[cfg(not(feature = "server"))]
    Err(ServerFnError::new("Server feature not enabled"))
}

#[get("/api/groups/:group_id/channels", headers: HeaderMap)]
pub async fn list_channels(group_id: String) -> Result<Json<Vec<Channel>>, ServerFnError> {
    let user_id = crate::server::auth::require_bearer_user_id(&headers)?.user_id;

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

        Ok(Json(channels))
    }
    #[cfg(not(feature = "server"))]
    Ok(Json(vec![]))
}
