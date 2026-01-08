use serde::de::DeserializeOwned;
use serde::Serialize;
use reqwest::Client;

#[derive(Debug, Clone)]
pub struct ApiClient {
    client: Client,
    base_url: String,
    bearer_token: Option<String>,
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
    pub fn new(bearer_token: Option<String>) -> Self {
        Self {
            client: Client::new(),
            base_url: "".to_string(),
            bearer_token,
        }
    }

    pub fn with_token(mut self, bearer_token: Option<String>) -> Self {
        self.bearer_token = bearer_token;
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
        let mut rb = self.client.get(self.url(path));
        
        if let Some(token) = &self.bearer_token {
            rb = rb.bearer_auth(token);
        }

        let resp = rb.send()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))?;

        let status = resp.status().as_u16();
        let is_success = resp.status().is_success();
        
        let text = resp.text()
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
        let mut rb = self.client.post(self.url(path));
        if let Some(token) = &self.bearer_token {
             rb = rb.bearer_auth(token);
        }
        
        let resp = rb
            .json(body)
            .send()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))?;

        let status = resp.status().as_u16();
        let is_success = resp.status().is_success();
        let text = resp.text().await.map_err(|e| ApiError::Network(e.to_string()))?;

        if !is_success {
            return Err(ApiError::Http {
                status,
                body: text,
            });
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
        let mut rb = self.client.put(self.url(path));
        if let Some(token) = &self.bearer_token {
             rb = rb.bearer_auth(token);
        }

        let resp = rb
            .json(body)
            .send()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))?;

        let status = resp.status().as_u16();
        let is_success = resp.status().is_success();
        let text = resp.text().await.map_err(|e| ApiError::Network(e.to_string()))?;

        if !is_success {
            return Err(ApiError::Http {
                status,
                body: text,
            });
        }

        if text.is_empty() {
             serde_json::from_str("null").map_err(|e| ApiError::Deserialize(e.to_string()))
        } else {
             serde_json::from_str(&text).map_err(|e| ApiError::Deserialize(e.to_string()))
        }
    }
}
