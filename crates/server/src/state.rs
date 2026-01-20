//! Application state shared across request handlers.

use aurora_db::Aurora;
use std::sync::Arc;

/// Shared application state
#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Aurora>,
    pub base_url: String,
}

impl AppState {
    pub fn new(db: Aurora) -> Self {
        let base_url = std::env::var("FORUMALL_BASE_URL")
            .unwrap_or_else(|_| "http://localhost:8080".to_string());

        Self {
            db: Arc::new(db),
            base_url,
        }
    }

    /// Get the domain portion of the base URL
    pub fn domain(&self) -> String {
        self.base_url
            .trim_end_matches('/')
            .replace("http://", "")
            .replace("https://", "")
    }
}
