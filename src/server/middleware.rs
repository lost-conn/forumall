#[cfg(feature = "server")]
pub mod cors {
    use tower_http::cors::CorsLayer;
    pub fn api_cors_layer() -> CorsLayer {
        CorsLayer::new()
            .allow_origin(tower_http::cors::Any)
            .allow_methods(tower_http::cors::Any)
            .allow_headers(tower_http::cors::Any)
    }
}
