//! Shared data models for the OFSCP protocol and forumall application.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

// --- Common Definitions ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Discoverability {
    Private,
    Group,
    Public,
    Discoverable,
}

pub fn validate_resource_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == '-'
        })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum VisibilityPolicy {
    Public,
    Authenticated,
    SharedGroups,
    Contacts,
    Nobody,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataItem {
    pub schema: String,
    pub version: String,
    pub data: serde_json::Value,
}

pub type Metadata = Vec<MetadataItem>;

// --- Identity ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum UserRef {
    Uri(String),
    Handle(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub handle: String,
    pub domain: String,
    pub display_name: Option<String>,
    pub avatar: Option<String>,
    pub updated_at: DateTime<Utc>,
    pub metadata: Metadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserAccount {
    pub profile: UserProfile,
    pub settings: serde_json::Value,
}

// --- Objects ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub mime: String,
    pub url: String,
    pub size: u64,
}

// --- Messaging ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Content {
    pub text: String,
    pub mime: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageReference {
    #[serde(rename = "type")]
    pub r#type: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub edit_until: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BaseMessage {
    pub id: String,
    pub author: UserRef,
    #[serde(rename = "type")]
    pub r#type: MessageType,
    pub content: Content,
    pub attachments: Vec<Attachment>,
    pub reference: Option<MessageReference>,
    pub tags: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub permissions: Option<Permissions>,
    pub metadata: Metadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum MessageType {
    Message,
    Memo,
    Article,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reaction {
    pub id: String,
    pub author: UserRef,
    pub key: String,
    pub unicode: Option<String>,
    pub image: Option<String>,
    pub reference: MessageReference,
    pub created_at: DateTime<Utc>,
    pub metadata: Metadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum TimelineItem {
    Message(BaseMessage),
    Reaction(Reaction),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PagedResponse<T> {
    pub items: Vec<T>,
    pub page: PageInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub next_cursor: Option<String>,
    pub prev_cursor: Option<String>,
}

// --- Discovery ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryDocument {
    pub provider: ProviderInfo,
    pub capabilities: Capabilities,
    pub endpoints: Endpoints,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub domain: String,
    pub protocol_version: String,
    pub software: SoftwareInfo,
    pub contact: String,
    pub authentication: AuthenticationEndpoints,
    pub public_keys: Option<Vec<PublicKey>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticationEndpoints {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub userinfo_endpoint: String,
    pub jwks_uri: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicKey {
    pub kid: String,
    pub alg: PublicKeyAlg,
    pub public_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum PublicKeyAlg {
    Ed25519,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub message_types: Vec<MessageType>,
    pub discoverability: Vec<Discoverability>,
    pub metadata_schemas: Vec<MetadataSchemaInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataSchemaInfo {
    pub id: String,
    pub uri: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Endpoints {
    pub identity: String,
    pub groups: String,
    pub notifications: String,
    pub tiers: String,
}

// --- WebSocket ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsEnvelope<T> {
    pub id: String,
    #[serde(flatten)]
    pub payload: T,
    pub ts: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum ClientCommand {
    Subscribe {
        channel_id: String,
    },
    Unsubscribe {
        channel_id: String,
    },
    #[serde(rename = "message.create")]
    MessageCreate {
        channel_id: String,
        body: String,
        nonce: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum ServerEvent {
    #[serde(rename = "message.new")]
    MessageNew {
        message: BaseMessage,
    },
    Ack {
        nonce: String,
        message_id: String,
    },
    Error {
        code: String,
        message: String,
        correlation_id: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserJoinedGroup {
    pub group_id: String,
    pub host: Option<String>,
    pub name: String,
    pub joined_at: String,
}

// --- Groups ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(default = "default_join_policy")]
    pub join_policy: String,
    pub owner: String,
    pub created_at: String,
    pub updated_at: String,
}

fn default_join_policy() -> String {
    "open".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    pub group_id: String,
    pub name: String,
    pub topic: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

// --- Auth Request/Response Types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    pub handle: String,
    pub password: String,
    pub device_public_key: Option<String>,
    pub device_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub handle: String,
    pub password: String,
    pub device_public_key: Option<String>,
    pub device_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    pub user_id: String,
    pub key_id: Option<String>,
}

// --- Group Request/Response Types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGroupRequest {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub join_policy: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateChannelRequest {
    pub name: String,
    #[serde(default)]
    pub topic: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddMemberRequest {
    pub handle: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateGroupSettingsRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub join_policy: Option<String>,
}

/// Alias for consistency
pub type UpdateGroupRequest = UpdateGroupSettingsRequest;

// --- Messages Page ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessagesPage {
    pub items: Vec<TimelineItem>,
    pub page: PageInfo,
}

// --- Device Keys ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceKey {
    pub key_id: String,
    pub user_handle: String,
    pub public_key: String,
    pub device_name: String,
    pub created_at: String,
    pub last_used_at: String,
    pub revoked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterDeviceKeyRequest {
    pub public_key: String,
    pub device_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterDeviceKeyResponse {
    pub key_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryKey {
    pub key_id: String,
    pub algorithm: String,
    pub public_key: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicKeyDiscoveryResponse {
    pub actor: String,
    pub keys: Vec<DiscoveryKey>,
    pub cache_until: String,
}

// --- Messages ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMessageRequest {
    pub body: String,
    #[serde(default)]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMessage {
    pub id: String,
    pub channel_id: String,
    pub sender_user_id: String,
    pub body: String,
    pub created_at: String,
}

// --- Users ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddJoinedGroupRequest {
    pub group_id: String,
    pub host: Option<String>,
    pub name: String,
}
