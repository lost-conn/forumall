use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

// --- Common Definitions ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Discoverability {
    Private,
    Group,
    Public,
    Discoverable,
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
    pub id: String,
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
    Subscribe { channel_id: String },
    Unsubscribe { channel_id: String },
    #[serde(rename = "message.create")]
    MessageCreate { channel_id: String, body: String, nonce: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum ServerEvent {
    #[serde(rename = "message.new")]
    MessageNew { message: BaseMessage },
    Ack { nonce: String, message_id: String },
    Error { code: String, message: String, correlation_id: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserJoinedGroup {
    pub group_id: String,
    pub host: Option<String>,
    pub name: String,
    pub joined_at: String,
}
