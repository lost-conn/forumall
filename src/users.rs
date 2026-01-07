use dioxus::prelude::*;
use dioxus_fullstack::Json;
use crate::models::UserProfile;

#[get("/api/users/:id/profile")]
pub async fn get_user_profile(id: String) -> Result<Json<UserProfile>, ServerFnError> {
    #[cfg(feature = "server")]
    {
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

        let handle = user_doc.data.get("handle").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let domain = user_doc.data.get("domain").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let updated_at = user_doc.data.get("updated_at").and_then(|v| v.as_str()).unwrap_or("");
        let updated_at = chrono::DateTime::parse_from_rfc3339(updated_at)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(|_| chrono::Utc::now());

        Ok(Json(UserProfile {
            id,
            handle,
            domain,
            display_name: None,
            avatar: None,
            updated_at,
            metadata: vec![],
        }))
    }
    #[cfg(not(feature = "server"))]
    Err(ServerFnError::new("Server feature not enabled"))
}
