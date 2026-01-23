//! Frontend serving - proxy and static file services.

use axum::Router;
use axum_reverse_proxy::ReverseProxy;
use std::path::PathBuf;
use tower_http::services::{ServeDir, ServeFile};

use crate::config::FrontendMode;

/// Create a router with the appropriate frontend fallback based on configuration.
///
/// This function takes a router that has already had `.with_state()` applied,
/// and adds the appropriate frontend serving based on the mode.
pub fn with_frontend_fallback(router: Router, mode: &FrontendMode) -> Router {
    match mode {
        FrontendMode::Proxy { target } => {
            tracing::info!("Frontend mode: proxy to {}", target);
            // ReverseProxy with "/" path matches all routes not handled by the router
            let proxy: Router = ReverseProxy::new("/", target).into();
            router.merge(proxy)
        }
        FrontendMode::Static { dir } => {
            tracing::info!("Frontend mode: static files from {}", dir);
            let path = PathBuf::from(dir);
            let index_path = path.join("index.html");
            let serve_dir = ServeDir::new(&path).fallback(ServeFile::new(index_path));
            router.fallback_service(serve_dir)
        }
        FrontendMode::Disabled => {
            tracing::info!("Frontend mode: disabled (API only)");
            router
        }
    }
}
