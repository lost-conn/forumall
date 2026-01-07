use dioxus::prelude::*;
use serde::{Deserialize, Serialize};

// `web_sys` is only available in the wasm32/web build.
#[cfg(target_arch = "wasm32")]
use web_sys;

#[derive(Clone, Copy, Debug)]
pub struct AuthContext {
    pub session: Signal<Option<AuthSession>>,
    pub provider_domain: Signal<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct AuthSession {
    pub user_id: String,
    pub token: String,
}

const STORAGE_KEY: &str = "ofscp_session";
const DOMAIN_KEY: &str = "ofscp_provider_domain";

#[component]
pub fn AuthProvider(children: Element) -> Element {
    let session = use_signal(|| {
        #[cfg(target_arch = "wasm32")]
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
        #[cfg(target_arch = "wasm32")]
        if let Some(window) = web_sys::window() {
            if let Ok(Some(storage)) = window.local_storage() {
                if let Ok(Some(domain)) = storage.get_item(DOMAIN_KEY) {
                    return domain;
                }
            }
            // Default to the current origin's host (including port) for local development
            if let Ok(host) = window.location().host() {
                return host;
            }
        }
        "localhost".to_string() // Default
    });

    // Sync session to local storage
    use_effect(move || {
        let current = session.cloned();
        #[cfg(target_arch = "wasm32")]
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

    // Sync domain to local storage
    use_effect(move || {
        let domain = provider_domain.cloned();

        #[cfg(target_arch = "wasm32")]
        if let Some(window) = web_sys::window() {
            if let Ok(Some(storage)) = window.local_storage() {
                let _ = storage.set_item(DOMAIN_KEY, &domain);
            }
        }
    });

    use_context_provider(|| AuthContext {
        session: session,
        provider_domain: provider_domain,
    });

    children
}

impl AuthContext {
    pub fn login(&mut self, user_id: String, token: String) {
        self.session.set(Some(AuthSession { user_id, token }));
    }

    pub fn logout(&mut self) {
        self.session.set(None);
    }

    pub fn is_authenticated(&self) -> bool {
        self.session.read().is_some()
    }

    pub fn token(&self) -> Option<String> {
        self.session.read().as_ref().map(|s| s.token.clone())
    }

    pub fn user_id(&self) -> Option<String> {
        self.session.read().as_ref().map(|s| s.user_id.clone())
    }

    pub fn api_url(&self, path: &str) -> String {
        let domain = self.provider_domain.read().clone();

        // Allow passing through full URLs.
        if path.starts_with("http://") || path.starts_with("https://") {
            return path.to_string();
        }

        // If no provider domain is set, fall back to relative paths (same-origin).
        if domain.trim().is_empty() {
            return if path.starts_with('/') {
                path.to_string()
            } else {
                format!("/{path}")
            };
        }

        // Normalize to a base URL.
        let base = if domain.contains("://") {
            domain.trim_end_matches('/').to_string()
        } else if domain == "localhost"
            || domain.starts_with("localhost:")
            || domain.starts_with("127.0.0.1")
        {
            format!("http://{}", domain.trim_end_matches('/'))
        } else {
            format!("https://{}", domain.trim_end_matches('/'))
        };

        let base = base.trim_end_matches('/');
        let path = path.trim_start_matches('/');
        format!("{base}/{path}")
    }

    pub fn ws_url(&self, path: &str) -> String {
        let url = self.api_url(path);
        if url.starts_with("https://") {
            url.replacen("https://", "wss://", 1)
        } else if url.starts_with("http://") {
            url.replacen("http://", "ws://", 1)
        } else {
            // Handle relative paths by prepending the appropriate scheme if we are in a browser
            #[cfg(target_arch = "wasm32")]
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
                        if path.starts_with('/') {
                            path.to_string()
                        } else {
                            format!("/{path}")
                        }
                    );
                }
            }
            url
        }
    }
}
