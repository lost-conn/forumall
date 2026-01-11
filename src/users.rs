use crate::models::{UserJoinedGroup, UserProfile};
use dioxus::prelude::*;
use dioxus_fullstack::http::{Method, Uri};
use dioxus_fullstack::{HeaderMap, ServerFnError};

#[cfg(feature = "server")]
use crate::server::middleware::cors::api_cors_layer;

#[get("/api/users/:user_id/groups", headers: HeaderMap, method: Method, uri: Uri)]
#[middleware(api_cors_layer())]
pub async fn get_user_groups(user_id: String) -> Result<Vec<UserJoinedGroup>, ServerFnError> {
    #[cfg(feature = "server")]
    let auth_user = {
        let (uid, _) =
            crate::server::signature::verify_ofscp_signature(&method, &uri, &headers, &[])
                .await
                .map_err(|e| ServerFnError::new(format!("Signature error: {:?}", e)))?;
        uid
    };
    #[cfg(not(feature = "server"))]
    let auth_user = "dev-user".to_string();

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

#[get("/api/users/:handle/profile")]
#[middleware(api_cors_layer())]
pub async fn get_user_profile(handle: String) -> Result<UserProfile, ServerFnError> {
    let db = &*crate::DB;

    let user_doc = db
        .query("users")
        .filter(|f| f.eq("handle", handle.clone()))
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
        handle,
        domain,
        display_name: None,
        avatar: None,
        updated_at,
        metadata: vec![],
    })
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AddJoinedGroupRequest {
    pub group_id: String,
    pub name: String,
    pub host: Option<String>,
}

#[post("/api/users/:user_id/groups", headers: HeaderMap, method: Method, uri: Uri)]
#[middleware(api_cors_layer())]
pub async fn add_user_joined_group(
    user_id: String,
    payload: AddJoinedGroupRequest,
) -> Result<UserJoinedGroup, ServerFnError> {
    #[cfg(feature = "server")]
    let auth_user = {
        let body_bytes =
            serde_json::to_vec(&payload).map_err(|e| ServerFnError::new(e.to_string()))?;
        let (uid, _) =
            crate::server::signature::verify_ofscp_signature(&method, &uri, &headers, &body_bytes)
                .await
                .map_err(|e| ServerFnError::new(format!("Signature error: {:?}", e)))?;
        uid
    };
    #[cfg(not(feature = "server"))]
    let auth_user = "dev-user".to_string();

    if auth_user != user_id {
        return Err(ServerFnError::new("Unauthorized"));
    }

    let now = chrono::Utc::now().to_rfc3339();
    let host = payload
        .host
        .clone()
        .unwrap_or_else(|| "localhost".to_string());

    #[cfg(feature = "server")]
    {
        let db = &*crate::DB;
        db.insert_into(
            "user_joined_groups",
            vec![
                ("user_id", user_id.clone().into()),
                ("group_id", payload.group_id.clone().into()),
                ("host", host.clone().into()),
                ("name", payload.name.clone().into()),
                ("joined_at", now.clone().into()),
            ],
        )
        .await
        .map_err(|e| ServerFnError::new(format!("Database error: {}", e)))?;
    }

    Ok(UserJoinedGroup {
        group_id: payload.group_id,
        host: Some(host),
        name: payload.name,
        joined_at: now,
    })
}

#[post("/api/me/groups", headers: HeaderMap, method: Method, uri: Uri)]
#[middleware(api_cors_layer())]
pub async fn add_self_joined_group(
    payload: AddJoinedGroupRequest,
) -> Result<UserJoinedGroup, ServerFnError> {
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
    let host = payload
        .host
        .clone()
        .unwrap_or_else(|| "localhost".to_string());

    #[cfg(feature = "server")]
    {
        let db = &*crate::DB;
        db.insert_into(
            "user_joined_groups",
            vec![
                ("user_id", user_id.clone().into()),
                ("group_id", payload.group_id.clone().into()),
                ("host", host.clone().into()),
                ("name", payload.name.clone().into()),
                ("joined_at", now.clone().into()),
            ],
        )
        .await
        .map_err(|e| ServerFnError::new(format!("Database error: {}", e)))?;
    }

    Ok(UserJoinedGroup {
        group_id: payload.group_id,
        host: Some(host),
        name: payload.name,
        joined_at: now,
    })
}
