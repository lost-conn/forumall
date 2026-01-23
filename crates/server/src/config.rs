//! Server configuration from environment variables.

/// Frontend serving mode configuration.
#[derive(Debug, Clone)]
pub enum FrontendMode {
    /// Proxy requests to a development server (e.g., Dioxus dx serve).
    Proxy { target: String },
    /// Serve static files from a directory.
    Static { dir: String },
    /// No frontend serving - API only.
    Disabled,
}

impl FrontendMode {
    /// Parse frontend mode from environment variables.
    ///
    /// Environment variables:
    /// - `FORUMALL_FRONTEND_MODE`: "proxy" | "static" | "disabled" (default: "disabled")
    /// - `FORUMALL_PROXY_TARGET`: Target URL for proxy mode (default: "http://localhost:8081")
    /// - `FORUMALL_STATIC_DIR`: Directory for static mode (default: "./crates/client/dist")
    pub fn from_env() -> Self {
        let mode = std::env::var("FORUMALL_FRONTEND_MODE")
            .unwrap_or_else(|_| "disabled".to_string())
            .to_lowercase();

        match mode.as_str() {
            "proxy" => {
                let target = std::env::var("FORUMALL_PROXY_TARGET")
                    .unwrap_or_else(|_| "http://localhost:8081".to_string());
                FrontendMode::Proxy { target }
            }
            "static" => {
                let dir = std::env::var("FORUMALL_STATIC_DIR")
                    .unwrap_or_else(|_| "./public".to_string());
                FrontendMode::Static { dir }
            }
            _ => FrontendMode::Disabled,
        }
    }
}
