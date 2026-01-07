use crate::models::{UserJoinedGroup, UserProfile};
use dioxus::prelude::*;
use dioxus_fullstack::HeaderMap;

#[get("/api/users/:user_id/groups", headers: HeaderMap)]
pub async fn get_user_groups(user_id: String) -> Result<Vec<UserJoinedGroup>, ServerFnError> {
    // 1. Authenticate. We should ensure the caller is allowed to see these groups.
    // For now, we only allow the user themselves to see their joined groups.
    let auth_user = crate::server::auth::require_bearer_user_id(&headers)?.user_id;
    if auth_user != user_id {
        return Err(ServerFnError::new(
            "Unauthorized: You can only view your own joined groups.",
        ));
    }

    let db = &*crate::DB;

    let groups = db
        .query("user_joined_groups")
        .filter(|f| f.eq("user_id", user_id.clone()))
        .collect()
        .await
        .map_err(|e| ServerFnError::new(format!("Database error: {}", e)))?
        .into_iter()
        .map(|doc| {
            let group_id = doc
                .data
                .get("group_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let host = doc
                .data
                .get("host")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let name = doc
                .data
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let joined_at = doc
                .data
                .get("joined_at")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            UserJoinedGroup {
                group_id,
                host,
                name,
                joined_at,
            }
        })
        .collect();

    Ok(groups)
}

#[get("/api/users/:id/profile")]
pub async fn get_user_profile(id: String) -> Result<UserProfile, ServerFnError> {
    let db = &*crate::DB;

    let user_doc = db
        .query("users")
        .filter(|f| f.eq("id", id.clone()))
        .collect()
        .await
        .map_err(|e| ServerFnError::new(format!("Database error: {e}")))?
        .into_iter()
        .next()
        .ok_or_else(|| ServerFnError::new("User not found"))?;

    let handle = user_doc
        .data
        .get("handle")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let domain = user_doc
        .data
        .get("domain")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let updated_at = user_doc
        .data
        .get("updated_at")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let updated_at = chrono::DateTime::parse_from_rfc3339(updated_at)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .unwrap_or_else(|_| chrono::Utc::now());

    Ok(UserProfile {
        id,
        handle,
        domain,
        display_name: None,
        avatar: None,
        updated_at,
        metadata: vec![],
    })
}
