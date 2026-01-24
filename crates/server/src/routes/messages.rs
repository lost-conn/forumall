//! Message routes.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use base64::Engine as _;
use forumall_shared::{ChannelMessage, MessageType};
use serde::{Deserialize, Serialize};

use crate::middleware::signature::{SignedJson, SignedRequest};
use crate::routes::channels::{check_channel_permission, get_settings_from_doc, ChannelPermission};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageRequest {
    pub body: String,
    /// Optional title for Article messages
    #[serde(default)]
    pub title: Option<String>,
    /// Message type (defaults to Message if not specified)
    #[serde(default)]
    pub message_type: Option<MessageType>,
    /// Parent message ID for replies (if set, this is a reply)
    #[serde(default)]
    pub parent_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SendMessageResponse {
    pub message: ChannelMessage,
}

#[derive(Debug, Deserialize)]
pub struct ListMessagesQuery {
    pub cursor: Option<String>,
    pub direction: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct MessagesPage {
    pub items: Vec<ChannelMessage>,
    pub page: PageInfo,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub next_cursor: Option<String>,
    pub prev_cursor: Option<String>,
}

/// Send a message to a channel
pub async fn send_message(
    State(state): State<AppState>,
    Path((group_id, channel_id)): Path<(String, String)>,
    SignedJson { value: payload, user_id, .. }: SignedJson<SendMessageRequest>,
) -> Result<Json<SendMessageResponse>, (StatusCode, String)> {
    // Verify channel belongs to group
    let channel_match = state.db
        .query("channels")
        .filter(|f| f.eq("id", channel_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?
        .into_iter()
        .next()
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Channel not found".to_string()))?;

    let channel_group_id = channel_match.data
        .get("group_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if channel_group_id != group_id {
        return Err((StatusCode::NOT_FOUND, "Channel not found in group".to_string()));
    }

    // Check send permission
    let channel_settings = get_settings_from_doc(&channel_match);
    let can_send = check_channel_permission(
        &state,
        &user_id,
        &group_id,
        &channel_settings,
        ChannelPermission::Send,
    )
    .await?;

    if !can_send {
        return Err((StatusCode::FORBIDDEN, "You don't have permission to send messages in this channel".to_string()));
    }

    // Validate message type
    let message_type = payload.message_type.clone().unwrap_or(MessageType::Message);
    let is_reply = payload.parent_id.is_some();

    let allowed_types = if is_reply {
        &channel_settings.message_types.reply_types
    } else {
        &channel_settings.message_types.root_types
    };

    if !allowed_types.contains(&message_type) {
        let type_name = match message_type {
            MessageType::Message => "message",
            MessageType::Memo => "memo",
            MessageType::Article => "article",
        };
        let context = if is_reply { "replies" } else { "root messages" };
        return Err((
            StatusCode::BAD_REQUEST,
            format!("Message type '{}' is not allowed for {} in this channel", type_name, context),
        ));
    }

    // If this is a reply, verify parent exists
    if let Some(ref parent_id) = payload.parent_id {
        let parent_exists = state.db
            .query("messages")
            .filter(|f| f.eq("id", parent_id.clone()) & f.eq("channel_id", channel_id.clone()))
            .collect()
            .await
            .map(|docs| !docs.is_empty())
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?;

        if !parent_exists {
            return Err((StatusCode::NOT_FOUND, "Parent message not found".to_string()));
        }
    }

    let message_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    // Serialize message type to store in DB
    let message_type_str = match message_type {
        MessageType::Message => "message",
        MessageType::Memo => "memo",
        MessageType::Article => "article",
    };

    // Build insert fields, conditionally including title
    let mut fields = vec![
        ("id", message_id.clone().into()),
        ("channel_id", channel_id.clone().into()),
        ("sender_user_id", user_id.clone().into()),
        ("body", payload.body.clone().into()),
        ("message_type", message_type_str.into()),
        ("created_at", now.clone().into()),
    ];

    if let Some(ref title) = payload.title {
        fields.push(("title", title.clone().into()));
    }

    state.db
        .insert_into("messages", fields)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?;

    Ok(Json(SendMessageResponse {
        message: ChannelMessage {
            id: message_id,
            channel_id,
            sender_user_id: user_id,
            title: payload.title,
            body: payload.body,
            message_type: Some(message_type),
            created_at: now,
        },
    }))
}

/// List messages in a channel
pub async fn list_messages(
    State(state): State<AppState>,
    Path((group_id, channel_id)): Path<(String, String)>,
    Query(query): Query<ListMessagesQuery>,
    signed: SignedRequest,
) -> Result<Json<MessagesPage>, (StatusCode, String)> {
    let limit = query.limit.unwrap_or(50).min(200) as usize;
    let direction = query.direction.unwrap_or_else(|| "backward".to_string());

    if direction != "backward" && direction != "forward" {
        return Err((StatusCode::BAD_REQUEST, "Unsupported direction".to_string()));
    }

    // Verify channel belongs to group
    let channel_match = state.db
        .query("channels")
        .filter(|f| f.eq("id", channel_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?
        .into_iter()
        .next()
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Channel not found".to_string()))?;

    let channel_group_id = channel_match.data
        .get("group_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if channel_group_id != group_id {
        return Err((StatusCode::NOT_FOUND, "Channel not found in group".to_string()));
    }

    // Check view permission
    let channel_settings = get_settings_from_doc(&channel_match);
    let can_view = check_channel_permission(
        &state,
        &signed.user_id,
        &group_id,
        &channel_settings,
        ChannelPermission::View,
    )
    .await?;

    if !can_view {
        return Err((StatusCode::FORBIDDEN, "You don't have permission to view this channel".to_string()));
    }

    // Cursor helpers
    let decode_cursor = |c: &str| -> Option<(String, String)> {
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(c).ok()?;
        let s = String::from_utf8(raw).ok()?;
        let (ts, id) = s.split_once('|')?;
        Some((ts.to_string(), id.to_string()))
    };

    let encode_cursor = |ts: &str, id: &str| -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!("{}|{}", ts, id))
    };

    let cursor_decoded = query.cursor.as_deref().and_then(decode_cursor);

    // Fetch messages
    let messages_all = state.db
        .query("messages")
        .filter(|f| f.eq("channel_id", channel_id.clone()))
        .collect()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?;

    let mut sorted = messages_all;
    sorted.sort_by(|a, b| {
        let a_ts = a.data.get("created_at").and_then(|v| v.as_str()).unwrap_or("");
        let b_ts = b.data.get("created_at").and_then(|v| v.as_str()).unwrap_or("");
        let ts_cmp = a_ts.cmp(b_ts);
        if ts_cmp == std::cmp::Ordering::Equal {
            let a_id = a.data.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let b_id = b.data.get("id").and_then(|v| v.as_str()).unwrap_or("");
            a_id.cmp(b_id)
        } else {
            ts_cmp
        }
    });

    let mut filtered: Vec<aurora_db::Document> = if let Some((ts, mid)) = cursor_decoded {
        if direction == "forward" {
            sorted.into_iter().filter(|m| {
                let m_ts = m.data.get("created_at").and_then(|v| v.as_str()).unwrap_or("");
                let m_id = m.data.get("id").and_then(|v| v.as_str()).unwrap_or("");
                m_ts > ts.as_str() || (m_ts == ts.as_str() && m_id > mid.as_str())
            }).collect()
        } else {
            let mut res: Vec<aurora_db::Document> = sorted.into_iter().filter(|m| {
                let m_ts = m.data.get("created_at").and_then(|v| v.as_str()).unwrap_or("");
                let m_id = m.data.get("id").and_then(|v| v.as_str()).unwrap_or("");
                m_ts < ts.as_str() || (m_ts == ts.as_str() && m_id < mid.as_str())
            }).collect();
            res.reverse();
            res
        }
    } else {
        if direction == "forward" {
            sorted
        } else {
            sorted.reverse();
            sorted
        }
    };

    let page_items: Vec<_> = filtered.drain(..limit.min(filtered.len())).collect();
    let mut items: Vec<ChannelMessage> = page_items
        .into_iter()
        .map(|m| {
            // Parse message_type from string
            let message_type = m.data.get("message_type")
                .and_then(|v| v.as_str())
                .map(|s| match s {
                    "memo" => MessageType::Memo,
                    "article" => MessageType::Article,
                    _ => MessageType::Message,
                });

            ChannelMessage {
                id: m.data.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                channel_id: m.data.get("channel_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                sender_user_id: m.data.get("sender_user_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                title: m.data.get("title").and_then(|v| v.as_str()).map(|s| s.to_string()),
                body: m.data.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                message_type,
                created_at: m.data.get("created_at").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            }
        })
        .collect();

    if direction == "backward" {
        items.reverse();
    }

    let next_cursor = items.first().map(|m| encode_cursor(&m.created_at, &m.id));
    let prev_cursor = items.last().map(|m| encode_cursor(&m.created_at, &m.id));

    Ok(Json(MessagesPage {
        items,
        page: PageInfo {
            next_cursor,
            prev_cursor,
        },
    }))
}
