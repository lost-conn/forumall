use dioxus_fullstack::{delete, get, post, HeaderMap, ServerFnError}; // Added HeaderMap
use serde::{Deserialize, Serialize};

#[cfg(feature = "server")]
use crate::server::middleware::cors::api_cors_layer;
use crate::server::signature::SignedJson;
use dioxus_fullstack::http::{Method, Uri};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeviceKey {
    pub key_id: String,
    pub user_handle: String,
    pub public_key: String,
    pub device_name: String,
    pub created_at: String,
    pub last_used_at: String,
    pub revoked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterDeviceKeyRequest {
    pub public_key: String,
    pub device_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterDeviceKeyResponse {
    pub key_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveryKey {
    pub key_id: String,
    pub algorithm: String,
    pub public_key: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicKeyDiscoveryResponse {
    pub actor: String,
    pub keys: Vec<DiscoveryKey>,
    pub cache_until: String,
}

#[post("/api/auth/device-keys")]
#[middleware(api_cors_layer())]
pub async fn register_device_key(
    signed: SignedJson<RegisterDeviceKeyRequest>,
) -> Result<RegisterDeviceKeyResponse, ServerFnError> {
    let payload = signed.value;
    let auth_user = signed.user_id;

    #[cfg(feature = "server")]
    {
        // 2. Validate input (basic check)
        if payload.public_key.trim().is_empty() {
            return Err(ServerFnError::new("Public key is required"));
        }
        if payload.device_name.trim().is_empty() {
            return Err(ServerFnError::new("Device name is required"));
        }

        let key_id = format!("dk_{}", uuid::Uuid::new_v4().to_string().replace("-", ""));
        let now = chrono::Utc::now().to_rfc3339();

        let db = &*crate::DB;
        db.insert_into(
            "device_keys",
            vec![
                ("key_id", key_id.clone().into()),
                ("user_handle", auth_user.clone().into()),
                ("public_key", payload.public_key.into()),
                ("device_name", payload.device_name.into()),
                ("created_at", now.clone().into()),
                ("last_used_at", now.clone().into()),
                ("revoked", "false".into()),
            ],
        )
        .await
        .map_err(|e| ServerFnError::new(format!("Database error: {e}")))?;

        Ok(RegisterDeviceKeyResponse {
            key_id,
            created_at: now,
        })
    }

    #[cfg(not(feature = "server"))]
    Ok(RegisterDeviceKeyResponse {
        key_id: String::new(),
        created_at: String::new(),
    })
}

#[get("/api/auth/device-keys", headers: HeaderMap, method: Method, uri: Uri)]
#[middleware(api_cors_layer())]
pub async fn list_device_keys() -> Result<Vec<DeviceKey>, ServerFnError> {
    #[cfg(feature = "server")]
    let (auth_user, _key_id) =
        crate::server::signature::verify_ofscp_signature(&method, &uri, &headers, &[])
            .await
            .map_err(|e| ServerFnError::new(format!("Signature error: {:?}", e)))?;
    #[cfg(not(feature = "server"))]
    let auth_user = "dev-user".to_string();

    #[cfg(feature = "server")]
    {
        let db = &*crate::DB;
        let keys = db
            .query("device_keys")
            .filter(|f| f.eq("user_handle", auth_user.clone()))
            .collect()
            .await
            .map_err(|e| ServerFnError::new(format!("Database error: {e}")))?
            .into_iter()
            .map(|doc| {
                let key_id = doc
                    .data
                    .get("key_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let user_handle = doc
                    .data
                    .get("user_handle")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let public_key = doc
                    .data
                    .get("public_key")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let device_name = doc
                    .data
                    .get("device_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let created_at = doc
                    .data
                    .get("created_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let last_used_at = doc
                    .data
                    .get("last_used_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let revoked = doc
                    .data
                    .get("revoked")
                    .and_then(|v| v.as_str())
                    .map(|s| s == "true")
                    .unwrap_or(false);

                DeviceKey {
                    key_id,
                    user_handle,
                    public_key,
                    device_name,
                    created_at,
                    last_used_at,
                    revoked,
                }
            })
            .collect();

        Ok(keys)
    }

    #[cfg(not(feature = "server"))]
    Ok(vec![])
}

#[delete("/api/auth/device-keys/:key_id", headers: HeaderMap, method: Method, uri: Uri)]
#[middleware(api_cors_layer())]
pub async fn revoke_device_key(key_id: String) -> Result<(), ServerFnError> {
    #[cfg(feature = "server")]
    let (auth_user, _key_id) =
        crate::server::signature::verify_ofscp_signature(&method, &uri, &headers, &[])
            .await
            .map_err(|e| ServerFnError::new(format!("Signature error: {:?}", e)))?;
    #[cfg(not(feature = "server"))]
    let auth_user = "dev-user".to_string();

    #[cfg(feature = "server")]
    {
        let db = &*crate::DB;

        // Find the key to ensure it belongs to the user
        let mut keys = db
            .query("device_keys")
            .filter(|f| f.eq("key_id", key_id.clone()))
            .filter(|f| f.eq("user_handle", auth_user.clone()))
            .collect()
            .await
            .map_err(|e| ServerFnError::new(format!("Database error: {e}")))?;

        if keys.is_empty() {
            return Err(ServerFnError::new("Key not found or unauthorized"));
        }

        // aurora-db doesn't have a direct update-by-query that is easy without knowing exact ID sometimes,
        // but here we can iterate. Actually, wait. aurora-db's update might need the doc id (internal).
        // Let's see how `update` works. Usually `db.update("collection", doc_id, fields)`.
        // The query result gives us `doc.id`.

        let doc = keys.pop().unwrap();

        db.update_document("device_keys", &doc.id, vec![("revoked", "true".into())])
            .await
            .map_err(|e| ServerFnError::new(format!("Database error: {e}")))?;

        Ok(())
    }

    #[cfg(not(feature = "server"))]
    Ok(())
}

#[get("/.well-known/ofscp/users/:handle/keys")]
#[middleware(api_cors_layer())]
pub async fn get_public_keys(handle: String) -> Result<PublicKeyDiscoveryResponse, ServerFnError> {
    #[cfg(feature = "server")]
    {
        let db = &*crate::DB;

        let keys: Vec<DiscoveryKey> = db
            .query("device_keys")
            .filter(|f| f.eq("user_handle", handle.clone()))
            .filter(|f| f.eq("revoked", "false"))
            .collect()
            .await
            .map_err(|e| ServerFnError::new(format!("Database error: {e}")))?
            .into_iter()
            .map(|doc| {
                let key_id = doc
                    .data
                    .get("key_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let public_key = doc
                    .data
                    .get("public_key")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let created_at = doc
                    .data
                    .get("created_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                DiscoveryKey {
                    key_id,
                    algorithm: "Ed25519".to_string(),
                    public_key,
                    created_at,
                }
            })
            .collect();

        // Check if user exists? Spec says "Revoked keys MUST NOT appear". Use cache_until.
        // If user doesn't exist, we just return empty keys?
        // Or should we return 404? Spec doesn't strictly say. Empty list is safer for privacy enumeration prevention but 404 is standard.
        // For now, empty list is fine if we don't fetch user.

        let domain = dioxus_fullstack::get_server_url()
            .trim_end_matches('/')
            .replace("http://", "")
            .replace("https://", "");
        let actor = format!("@{handle}@{domain}");

        let now = chrono::Utc::now();
        let cache_until = (now + chrono::Duration::hours(1)).to_rfc3339();

        Ok(PublicKeyDiscoveryResponse {
            actor,
            keys,
            cache_until,
        })
    }

    #[cfg(not(feature = "server"))]
    Ok(PublicKeyDiscoveryResponse {
        actor: String::new(),
        keys: vec![],
        cache_until: String::new(),
    })
}
