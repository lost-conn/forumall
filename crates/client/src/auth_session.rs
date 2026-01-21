//! Authentication session management with localStorage persistence.

use dioxus::prelude::*;
use serde::{Deserialize, Serialize};

use crate::api_client::ApiClient;
use crate::client_keys::KeyPair;
use crate::ws;

const STORAGE_KEY: &str = "ofscp_session";
const DOMAIN_KEY: &str = "ofscp_provider_domain";

/// Authentication context provided to the app
#[derive(Clone, Copy, Debug)]
pub struct AuthContext {
    pub session: Signal<Option<AuthSession>>,
    pub provider_domain: Signal<String>,
}

/// Stored session data
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct AuthSession {
    pub user_id: String,
    pub keys: Option<KeyPair>,
}

/// Provider component that sets up auth context
#[component]
pub fn AuthProvider(children: Element) -> Element {
    let session = use_signal(|| {
        if let Some(window) = web_sys::window() {
            if let Ok(Some(storage)) = window.local_storage() {
                if let Ok(Some(data)) = storage.get_item(STORAGE_KEY) {
                    if let Ok(sess) = serde_json::from_str::<AuthSession>(&data) {
                        return Some(sess);
                    }
                }
            }
        }
        None
    });

    let provider_domain = use_signal(|| {
        if let Some(window) = web_sys::window() {
            if let Ok(Some(storage)) = window.local_storage() {
                if let Ok(Some(domain)) = storage.get_item(DOMAIN_KEY) {
                    return domain;
                }
            }
            // Default to current origin's host
            if let Ok(host) = window.location().host() {
                return host;
            }
        }
        "localhost".to_string()
    });

    // Sync session to localStorage
    use_effect(move || {
        let current = session.cloned();
        if let Some(window) = web_sys::window() {
            if let Ok(Some(storage)) = window.local_storage() {
                if let Some(sess) = current.as_ref() {
                    if let Ok(data) = serde_json::to_string(sess) {
                        let _ = storage.set_item(STORAGE_KEY, &data);
                    }
                } else {
                    let _ = storage.remove_item(STORAGE_KEY);
                }
            }
        }
    });

    // Sync domain to localStorage
    use_effect(move || {
        let domain = provider_domain.cloned();
        if let Some(window) = web_sys::window() {
            if let Ok(Some(storage)) = window.local_storage() {
                let _ = storage.set_item(DOMAIN_KEY, &domain);
            }
        }
    });

    use_context_provider(|| AuthContext {
        session,
        provider_domain,
    });

    children
}

impl AuthContext {
    /// Login with keys
    pub fn login_with_keys(&mut self, user_id: String, keys: Option<KeyPair>) {
        self.session.set(Some(AuthSession { user_id, keys }));
    }

    /// Logout and clear session
    pub fn logout(&mut self) {
        ws::clear_connections();

        if let Some(window) = web_sys::window() {
            if let Ok(Some(storage)) = window.local_storage() {
                let _ = storage.remove_item(STORAGE_KEY);
            }
        }
        self.session.set(None);
    }

    /// Create an API client configured for the current session
    pub fn client(&self) -> ApiClient {
        let session = self.session.read();
        let domain = self.provider_domain.read().clone();

        ApiClient::new()
            .with_base_url(self.api_base_url())
            .with_signing(
                session.as_ref().and_then(|s| s.keys.clone()),
                session.as_ref().map(|s| s.user_id.clone()),
                Some(domain),
            )
    }

    /// Check if user is authenticated
    pub fn is_authenticated(&self) -> bool {
        self.session.read().is_some()
    }

    /// Get the current user ID
    pub fn user_id(&self) -> Option<String> {
        self.session.read().as_ref().map(|s| s.user_id.clone())
    }

    /// Get the base URL for API calls
    fn api_base_url(&self) -> String {
        let domain = self.provider_domain.read().clone();

        if domain.trim().is_empty() {
            return String::new(); // Use relative paths
        }

        if domain.contains("://") {
            domain.trim_end_matches('/').to_string()
        } else {
            let host_part = domain.split(':').next().unwrap_or(&domain);
            let is_local = host_part == "localhost"
                || host_part == "127.0.0.1"
                || host_part == "0.0.0.0"
                || host_part.starts_with("192.168.")
                || host_part.starts_with("10.");

            if is_local {
                format!("http://{}", domain.trim_end_matches('/'))
            } else {
                format!("https://{}", domain.trim_end_matches('/'))
            }
        }
    }

    /// Construct API URL for a specific host
    pub fn api_url_for_host(&self, host: Option<&str>, path: &str) -> String {
        let host = host.unwrap_or("");
        let current_domain = self.provider_domain.read().clone();

        let normalized_host = host
            .trim_start_matches("http://")
            .trim_start_matches("https://")
            .trim_end_matches('/');

        let normalized_current = current_domain
            .trim_start_matches("http://")
            .trim_start_matches("https://")
            .trim_end_matches('/');

        if host.is_empty() || normalized_host == normalized_current {
            return self.api_url(path);
        }

        let host_part = normalized_host.split(':').next().unwrap_or(normalized_host);
        let is_local = host_part == "localhost"
            || host_part == "127.0.0.1"
            || host_part == "0.0.0.0"
            || host_part.starts_with("192.168.")
            || host_part.starts_with("10.");

        let base = if host.contains("://") {
            host.trim_end_matches('/').to_string()
        } else if is_local {
            format!("http://{}", normalized_host)
        } else {
            format!("https://{}", normalized_host)
        };

        let base = base.trim_end_matches('/');
        let path = path.trim_start_matches('/');
        format!("{base}/{path}")
    }

    /// Construct API URL using current provider
    pub fn api_url(&self, path: &str) -> String {
        if path.starts_with("http://") || path.starts_with("https://") {
            return path.to_string();
        }

        let base = self.api_base_url();
        if base.is_empty() {
            if path.starts_with('/') {
                path.to_string()
            } else {
                format!("/{path}")
            }
        } else {
            let base = base.trim_end_matches('/');
            let path = path.trim_start_matches('/');
            format!("{base}/{path}")
        }
    }

    /// Construct WebSocket URL for the local provider
    pub fn ws_url(&self, path: &str) -> String {
        Self::http_to_ws(&self.api_url(path), path)
    }

    /// Construct WebSocket URL for a specific host
    pub fn ws_url_for_host(&self, host: Option<&str>, path: &str) -> String {
        Self::http_to_ws(&self.api_url_for_host(host, path), path)
    }

    /// Convert HTTP/HTTPS URL to WS/WSS
    fn http_to_ws(url: &str, path: &str) -> String {
        if url.starts_with("https://") {
            url.replacen("https://", "wss://", 1)
        } else if url.starts_with("http://") {
            url.replacen("http://", "ws://", 1)
        } else {
            // Handle relative paths
            if let Some(window) = web_sys::window() {
                if let Ok(origin) = window.location().origin() {
                    let ws_origin = if origin.starts_with("https://") {
                        origin.replacen("https://", "wss://", 1)
                    } else {
                        origin.replacen("http://", "ws://", 1)
                    };
                    return format!(
                        "{}{}",
                        ws_origin.trim_end_matches('/'),
                        if path.starts_with('/') { path.to_string() } else { format!("/{path}") }
                    );
                }
            }
            url.to_string()
        }
    }
}
