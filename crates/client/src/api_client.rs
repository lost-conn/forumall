//! HTTP API client with OFSCP signature support.

use forumall_shared::ApiError;
use reqwest::Client;
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::client_keys::{sign_request, KeyPair};

/// HTTP client for making signed API requests to any OFSCP provider.
#[derive(Debug, Clone)]
pub struct ApiClient {
    client: Client,
    base_url: String,
    keys: Option<KeyPair>,
    handle: Option<String>,
    domain: Option<String>,
}

impl ApiClient {
    /// Create a new API client
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            base_url: String::new(),
            keys: None,
            handle: None,
            domain: None,
        }
    }

    /// Set the base URL for API requests
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    /// Configure signing credentials
    pub fn with_signing(
        mut self,
        keys: Option<KeyPair>,
        handle: Option<String>,
        domain: Option<String>,
    ) -> Self {
        self.keys = keys;
        self.handle = handle;
        self.domain = domain;
        self
    }

    fn url(&self, path: &str) -> String {
        if path.starts_with("http://") || path.starts_with("https://") {
            return path.to_string();
        }
        if self.base_url.is_empty() {
            if path.starts_with('/') {
                path.to_string()
            } else {
                format!("/{path}")
            }
        } else {
            let base = self.base_url.trim_end_matches('/');
            let path = path.trim_start_matches('/');
            format!("{base}/{path}")
        }
    }

    /// Make a signed GET request
    pub async fn get_json<TRes: DeserializeOwned>(&self, path: &str) -> Result<TRes, ApiError> {
        let url = self.url(path);
        let mut rb = self.client.get(&url);

        if let (Some(keys), Some(handle), Some(domain)) = (&self.keys, &self.handle, &self.domain) {
            let path_only = if let Ok(u) = reqwest::Url::parse(&url) {
                u.path().to_string()
            } else {
                path.split('?').next().unwrap_or(path).to_string()
            };

            if let Some(headers) = sign_request("GET", &path_only, &[], keys, handle, domain) {
                rb = rb.header("X-OFSCP-Actor", headers.actor);
                rb = rb.header("X-OFSCP-Timestamp", headers.timestamp);
                rb = rb.header(
                    "X-OFSCP-Signature",
                    format!("keyId=\"{}\", signature=\"{}\"", headers.key_id, headers.signature),
                );
            }
        }

        let resp = rb.send().await.map_err(|e| ApiError::Network(e.to_string()))?;

        let status = resp.status().as_u16();
        let is_success = resp.status().is_success();

        let text = resp.text().await.map_err(|e| ApiError::Network(format!("failed to read body: {e}")))?;

        if !is_success {
            return Err(ApiError::Http { status, body: text });
        }

        serde_json::from_str(&text).map_err(|e| ApiError::Deserialize(e.to_string()))
    }

    /// Make a signed POST request with JSON body
    pub async fn post_json<TReq: Serialize, TRes: DeserializeOwned>(
        &self,
        path: &str,
        body: &TReq,
    ) -> Result<TRes, ApiError> {
        let url = self.url(path);
        let mut rb = self.client.post(&url);

        let body_bytes = serde_json::to_vec(body).map_err(|e| ApiError::Deserialize(e.to_string()))?;

        if let (Some(keys), Some(handle), Some(domain)) = (&self.keys, &self.handle, &self.domain) {
            let path_only = if let Ok(u) = reqwest::Url::parse(&url) {
                u.path().to_string()
            } else {
                path.split('?').next().unwrap_or(path).to_string()
            };

            if let Some(headers) = sign_request("POST", &path_only, &body_bytes, keys, handle, domain) {
                rb = rb.header("X-OFSCP-Actor", headers.actor);
                rb = rb.header("X-OFSCP-Timestamp", headers.timestamp);
                rb = rb.header(
                    "X-OFSCP-Signature",
                    format!("keyId=\"{}\", signature=\"{}\"", headers.key_id, headers.signature),
                );
            }
        }

        let resp = rb
            .body(body_bytes)
            .header("Content-Type", "application/json")
            .send()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))?;

        let status = resp.status().as_u16();
        let is_success = resp.status().is_success();
        let text = resp.text().await.map_err(|e| ApiError::Network(e.to_string()))?;

        if !is_success {
            return Err(ApiError::Http { status, body: text });
        }

        if text.is_empty() {
            serde_json::from_str("null").map_err(|e| ApiError::Deserialize(e.to_string()))
        } else {
            serde_json::from_str(&text).map_err(|e| ApiError::Deserialize(e.to_string()))
        }
    }

    /// Make a signed PUT request with JSON body
    pub async fn put_json<TReq: Serialize, TRes: DeserializeOwned>(
        &self,
        path: &str,
        body: &TReq,
    ) -> Result<TRes, ApiError> {
        let url = self.url(path);
        let mut rb = self.client.put(&url);

        let body_bytes = serde_json::to_vec(body).map_err(|e| ApiError::Deserialize(e.to_string()))?;

        if let (Some(keys), Some(handle), Some(domain)) = (&self.keys, &self.handle, &self.domain) {
            let path_only = if let Ok(u) = reqwest::Url::parse(&url) {
                u.path().to_string()
            } else {
                path.split('?').next().unwrap_or(path).to_string()
            };

            if let Some(headers) = sign_request("PUT", &path_only, &body_bytes, keys, handle, domain) {
                rb = rb.header("X-OFSCP-Actor", headers.actor);
                rb = rb.header("X-OFSCP-Timestamp", headers.timestamp);
                rb = rb.header(
                    "X-OFSCP-Signature",
                    format!("keyId=\"{}\", signature=\"{}\"", headers.key_id, headers.signature),
                );
            }
        }

        let resp = rb
            .body(body_bytes)
            .header("Content-Type", "application/json")
            .send()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))?;

        let status = resp.status().as_u16();
        let is_success = resp.status().is_success();
        let text = resp.text().await.map_err(|e| ApiError::Network(e.to_string()))?;

        if !is_success {
            return Err(ApiError::Http { status, body: text });
        }

        if text.is_empty() {
            serde_json::from_str("null").map_err(|e| ApiError::Deserialize(e.to_string()))
        } else {
            serde_json::from_str(&text).map_err(|e| ApiError::Deserialize(e.to_string()))
        }
    }

    /// Make a signed DELETE request
    pub async fn delete(&self, path: &str) -> Result<(), ApiError> {
        let url = self.url(path);
        let mut rb = self.client.delete(&url);

        if let (Some(keys), Some(handle), Some(domain)) = (&self.keys, &self.handle, &self.domain) {
            let path_only = if let Ok(u) = reqwest::Url::parse(&url) {
                u.path().to_string()
            } else {
                path.split('?').next().unwrap_or(path).to_string()
            };

            if let Some(headers) = sign_request("DELETE", &path_only, &[], keys, handle, domain) {
                rb = rb.header("X-OFSCP-Actor", headers.actor);
                rb = rb.header("X-OFSCP-Timestamp", headers.timestamp);
                rb = rb.header(
                    "X-OFSCP-Signature",
                    format!("keyId=\"{}\", signature=\"{}\"", headers.key_id, headers.signature),
                );
            }
        }

        let resp = rb.send().await.map_err(|e| ApiError::Network(e.to_string()))?;

        let status = resp.status().as_u16();
        let is_success = resp.status().is_success();

        let text = resp.text().await.map_err(|e| ApiError::Network(format!("failed to read body: {e}")))?;

        if !is_success {
            return Err(ApiError::Http { status, body: text });
        }

        Ok(())
    }

    /// Make a signed PATCH request with JSON body
    pub async fn patch_json<TReq: Serialize, TRes: DeserializeOwned>(
        &self,
        path: &str,
        body: &TReq,
    ) -> Result<TRes, ApiError> {
        let url = self.url(path);
        let mut rb = self.client.patch(&url);

        let body_bytes = serde_json::to_vec(body).map_err(|e| ApiError::Deserialize(e.to_string()))?;

        if let (Some(keys), Some(handle), Some(domain)) = (&self.keys, &self.handle, &self.domain) {
            let path_only = if let Ok(u) = reqwest::Url::parse(&url) {
                u.path().to_string()
            } else {
                path.split('?').next().unwrap_or(path).to_string()
            };

            if let Some(headers) = sign_request("PATCH", &path_only, &body_bytes, keys, handle, domain) {
                rb = rb.header("X-OFSCP-Actor", headers.actor);
                rb = rb.header("X-OFSCP-Timestamp", headers.timestamp);
                rb = rb.header(
                    "X-OFSCP-Signature",
                    format!("keyId=\"{}\", signature=\"{}\"", headers.key_id, headers.signature),
                );
            }
        }

        let resp = rb
            .body(body_bytes)
            .header("Content-Type", "application/json")
            .send()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))?;

        let status = resp.status().as_u16();
        let is_success = resp.status().is_success();
        let text = resp.text().await.map_err(|e| ApiError::Network(e.to_string()))?;

        if !is_success {
            return Err(ApiError::Http { status, body: text });
        }

        if text.is_empty() {
            serde_json::from_str("null").map_err(|e| ApiError::Deserialize(e.to_string()))
        } else {
            serde_json::from_str(&text).map_err(|e| ApiError::Deserialize(e.to_string()))
        }
    }

    // --- Profile/Presence/Privacy API methods ---

    /// Update the current user's profile
    pub async fn update_profile(
        &self,
        update: &forumall_shared::UpdateProfileRequest,
    ) -> Result<forumall_shared::UserProfile, ApiError> {
        self.patch_json("/api/me/profile", update).await
    }

    /// Get the current user's presence
    pub async fn get_own_presence(&self) -> Result<forumall_shared::Presence, ApiError> {
        self.get_json("/api/me/presence").await
    }

    /// Update the current user's presence
    pub async fn update_presence(
        &self,
        update: &forumall_shared::UpdatePresenceRequest,
    ) -> Result<forumall_shared::Presence, ApiError> {
        self.put_json("/api/me/presence", update).await
    }

    /// Get another user's presence
    pub async fn get_user_presence(&self, handle: &str) -> Result<forumall_shared::Presence, ApiError> {
        self.get_json(&format!("/api/users/{}/presence", handle)).await
    }

    /// Get the current user's privacy settings
    pub async fn get_privacy_settings(&self) -> Result<forumall_shared::PrivacySettings, ApiError> {
        self.get_json("/api/me/privacy").await
    }

    /// Update the current user's privacy settings
    pub async fn update_privacy_settings(
        &self,
        settings: &forumall_shared::PrivacySettings,
    ) -> Result<forumall_shared::PrivacySettings, ApiError> {
        self.put_json("/api/me/privacy", settings).await
    }

    /// Get a user's profile
    pub async fn get_user_profile(&self, handle: &str) -> Result<forumall_shared::UserProfile, ApiError> {
        self.get_json(&format!("/api/users/{}/profile", handle)).await
    }
}

impl Default for ApiClient {
    fn default() -> Self {
        Self::new()
    }
}
