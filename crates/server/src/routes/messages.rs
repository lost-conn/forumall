//! Message routes.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use base64::Engine as _;
use forumall_shared::ChannelMessage;
use serde::{Deserialize, Serialize};

use crate::middleware::signature::{SignedJson, SignedRequest};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct SendMessageRequest {
    pub body: String,
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

    // Check membership
    let is_member = state.db
        .query("group_members")
        .filter(|f| f.eq("group_id", group_id.clone()) & f.eq("user_id", user_id.clone()))
        .collect()
        .await
        .map(|docs| !docs.is_empty())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?;

    if !is_member {
        return Err((StatusCode::FORBIDDEN, "Not a member of that group".to_string()));
    }

    let message_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    state.db
        .insert_into(
            "messages",
            vec![
                ("id", message_id.clone().into()),
                ("channel_id", channel_id.clone().into()),
                ("sender_user_id", user_id.clone().into()),
                ("body", payload.body.clone().into()),
                ("created_at", now.clone().into()),
            ],
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?;

    Ok(Json(SendMessageResponse {
        message: ChannelMessage {
            id: message_id,
            channel_id,
            sender_user_id: user_id,
            body: payload.body,
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

    // Check membership
    let is_member = state.db
        .query("group_members")
        .filter(|f| f.eq("group_id", group_id.clone()) & f.eq("user_id", signed.user_id.clone()))
        .collect()
        .await
        .map(|docs| !docs.is_empty())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Database error: {e}")))?;

    if !is_member {
        return Err((StatusCode::FORBIDDEN, "Not a member of that group".to_string()));
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
            ChannelMessage {
                id: m.data.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                channel_id: m.data.get("channel_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                sender_user_id: m.data.get("sender_user_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                body: m.data.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string(),
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
