//! OFSCP discovery endpoint.

use axum::{extract::State, Json};
use forumall_shared::{
    AuthenticationEndpoints, Capabilities, Discoverability, DiscoveryDocument, Endpoints,
    MessageType, ProviderInfo, SoftwareInfo,
};

use crate::state::AppState;

/// OFSCP provider discovery endpoint
pub async fn ofscp_provider(State(state): State<AppState>) -> Json<DiscoveryDocument> {
    let base_url = state.base_url.trim_end_matches('/');
    let domain = state.domain();

    Json(DiscoveryDocument {
        provider: ProviderInfo {
            domain,
            protocol_version: "0.1.0".to_string(),
            software: SoftwareInfo {
                name: "Forumall Server".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
            },
            contact: "admin@localhost".to_string(),
            authentication: AuthenticationEndpoints {
                issuer: format!("{}/api/auth", base_url),
                authorization_endpoint: format!("{}/api/auth/authorize", base_url),
                token_endpoint: format!("{}/api/auth/token", base_url),
                userinfo_endpoint: format!("{}/api/auth/userinfo", base_url),
                jwks_uri: Some(format!("{}/.well-known/jwks.json", base_url)),
            },
            public_keys: None,
        },
        capabilities: Capabilities {
            message_types: vec![MessageType::Message, MessageType::Memo, MessageType::Article],
            discoverability: vec![Discoverability::Public],
            metadata_schemas: vec![],
        },
        endpoints: Endpoints {
            identity: format!("{}/api/identity", base_url),
            groups: format!("{}/api/groups", base_url),
            notifications: format!("{}/api/notifications", base_url),
            tiers: format!("{}/api/tiers", base_url),
        },
    })
}
