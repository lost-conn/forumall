use reqwest::Client;
use serde::de::DeserializeOwned;
use serde::Serialize;

#[derive(Debug, Clone)]
pub struct ApiClient {
    client: Client,
    base_url: String,
    keys: Option<crate::auth::client_keys::KeyPair>,
    handle: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiError {
    Network(String),
    Http { status: u16, body: String },
    Deserialize(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Network(msg) => write!(f, "Network error: {}", msg),
            ApiError::Http { status, body } => write!(f, "HTTP {}: {}", status, body),
            ApiError::Deserialize(msg) => write!(f, "Deserialization error: {}", msg),
        }
    }
}

impl std::error::Error for ApiError {}

impl ApiClient {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            base_url: "".to_string(),
            keys: None,
            handle: None,
        }
    }

    #[allow(dead_code)]
    pub fn with_signing(
        mut self,
        keys: Option<crate::auth::client_keys::KeyPair>,
        handle: Option<String>,
    ) -> Self {
        self.keys = keys;
        self.handle = handle;
        self
    }

    fn url(&self, path: &str) -> String {
        if path.starts_with("http://") || path.starts_with("https://") {
            return path.to_string();
        }
        if self.base_url.is_empty() {
            // Allow relative URLs (recommended for same-origin /api/*)
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

    pub async fn get_json<TRes: DeserializeOwned>(&self, path: &str) -> Result<TRes, ApiError> {
        let url = self.url(path);
        let mut rb = self.client.get(&url);

        // JWT logic removed

        // Sign if keys present
        if let (Some(keys), Some(handle)) = (&self.keys, &self.handle) {
            let path_only = if url.starts_with("http") {
                reqwest::Url::parse(&url)
                    .map(|u| u.path().to_string())
                    .unwrap_or_else(|_| path.to_string())
            } else {
                path.to_string()
            };

            if let Some(headers) =
                crate::auth::client_keys::sign_request("GET", &path_only, &[], keys, handle)
            {
                rb = rb.header("X-OFSCP-Actor", headers.actor);
                rb = rb.header("X-OFSCP-Key-ID", headers.key_id);
                rb = rb.header("X-OFSCP-Timestamp", headers.timestamp);
                rb = rb.header("X-OFSCP-Signature", headers.signature);
            }
        }

        let resp = rb
            .send()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))?;

        let status = resp.status().as_u16();
        let is_success = resp.status().is_success();

        let text = resp
            .text()
            .await
            .map_err(|e| ApiError::Network(format!("failed to read body: {e}")))?;

        if !is_success {
            return Err(ApiError::Http { status, body: text });
        }

        serde_json::from_str(&text).map_err(|e| ApiError::Deserialize(e.to_string()))
    }

    pub async fn post_json<TReq: Serialize, TRes: DeserializeOwned>(
        &self,
        path: &str,
        body: &TReq,
    ) -> Result<TRes, ApiError> {
        let url = self.url(path);
        let mut rb = self.client.post(&url);

        // JWT logic removed

        let body_bytes =
            serde_json::to_vec(body).map_err(|e| ApiError::Deserialize(e.to_string()))?;

        // Sign if keys present
        if let (Some(keys), Some(handle)) = (&self.keys, &self.handle) {
            let path_only = if url.starts_with("http") {
                reqwest::Url::parse(&url)
                    .map(|u| u.path().to_string())
                    .unwrap_or_else(|_| path.to_string())
            } else {
                path.to_string()
            };

            if let Some(headers) = crate::auth::client_keys::sign_request(
                "POST",
                &path_only,
                &body_bytes,
                keys,
                handle,
            ) {
                rb = rb.header("X-OFSCP-Actor", headers.actor);
                rb = rb.header("X-OFSCP-Key-ID", headers.key_id);
                rb = rb.header("X-OFSCP-Timestamp", headers.timestamp);
                rb = rb.header("X-OFSCP-Signature", headers.signature);
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
        let text = resp
            .text()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))?;

        if !is_success {
            return Err(ApiError::Http { status, body: text });
        }

        // Handle void returns which might be empty string
        if text.is_empty() {
            // This is hacky for (), but let's try serde
            serde_json::from_str("null").map_err(|e| ApiError::Deserialize(e.to_string()))
        } else {
            serde_json::from_str(&text).map_err(|e| ApiError::Deserialize(e.to_string()))
        }
    }

    pub async fn put_json<TReq: Serialize, TRes: DeserializeOwned>(
        &self,
        path: &str,
        body: &TReq,
    ) -> Result<TRes, ApiError> {
        let url = self.url(path);
        let mut rb = self.client.put(&url);

        let body_bytes =
            serde_json::to_vec(body).map_err(|e| ApiError::Deserialize(e.to_string()))?;

        // Sign if keys present
        if let (Some(keys), Some(handle)) = (&self.keys, &self.handle) {
            let path_only = if url.starts_with("http") {
                reqwest::Url::parse(&url)
                    .map(|u| u.path().to_string())
                    .unwrap_or_else(|_| path.to_string())
            } else {
                path.to_string()
            };

            if let Some(headers) =
                crate::auth::client_keys::sign_request("PUT", &path_only, &body_bytes, keys, handle)
            {
                rb = rb.header("X-OFSCP-Actor", headers.actor);
                rb = rb.header("X-OFSCP-Key-ID", headers.key_id);
                rb = rb.header("X-OFSCP-Timestamp", headers.timestamp);
                rb = rb.header("X-OFSCP-Signature", headers.signature);
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
        let text = resp
            .text()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))?;

        if !is_success {
            return Err(ApiError::Http { status, body: text });
        }

        if text.is_empty() {
            serde_json::from_str("null").map_err(|e| ApiError::Deserialize(e.to_string()))
        } else {
            serde_json::from_str(&text).map_err(|e| ApiError::Deserialize(e.to_string()))
        }
    }
}
