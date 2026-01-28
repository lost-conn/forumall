//! Database initialization and schema setup.

use aurora_db::{Aurora, FieldType};

/// Initialize the Aurora database with all collections.
pub fn init_database() -> Aurora {
    let db_path = std::env::var("FORUMALL_DB_PATH").unwrap_or_else(|_| "aurora_db_data".to_string());
    let db = Aurora::open(&db_path).expect("Failed to open database");

    // Initialize collections
    let _ = db.new_collection(
        "users",
        vec![
            ("handle", FieldType::String, true),
            ("domain", FieldType::String, false),
            ("password_hash", FieldType::String, false),
            ("display_name", FieldType::String, false),
            ("avatar", FieldType::String, false),
            ("bio", FieldType::String, false),
            ("metadata", FieldType::String, false), // JSON serialized
            ("created_at", FieldType::String, false),
            ("updated_at", FieldType::String, false),
        ],
    );

    let _ = db.new_collection(
        "groups",
        vec![
            ("id", FieldType::String, true),
            ("name", FieldType::String, false),
            ("description", FieldType::String, false),
            ("join_policy", FieldType::String, false),
            ("owner", FieldType::String, false),
            ("created_at", FieldType::String, false),
            ("updated_at", FieldType::String, false),
        ],
    );

    let _ = db.new_collection(
        "group_members",
        vec![
            ("group_id", FieldType::String, false),
            ("user_id", FieldType::String, false),
            ("role", FieldType::String, false),
            ("created_at", FieldType::String, false),
        ],
    );

    let _ = db.new_collection(
        "channels",
        vec![
            ("id", FieldType::String, true),
            ("group_id", FieldType::String, false),
            ("name", FieldType::String, false),
            ("channel_type", FieldType::String, false),
            ("topic", FieldType::String, false),
            ("discoverability", FieldType::String, false),
            ("settings", FieldType::String, false), // JSON serialized
            ("tags", FieldType::String, false),     // JSON serialized
            ("metadata", FieldType::String, false), // JSON serialized
            ("created_at", FieldType::String, false),
            ("updated_at", FieldType::String, false),
        ],
    );

    let _ = db.new_collection(
        "messages",
        vec![
            ("id", FieldType::String, true),
            ("channel_id", FieldType::String, false),
            ("sender_user_id", FieldType::String, false),
            ("body", FieldType::String, false),
            ("created_at", FieldType::String, false),
        ],
    );

    let _ = db.new_collection(
        "idempotency_keys",
        vec![
            ("user_id", FieldType::String, false),
            ("key", FieldType::String, false),
            ("created_at", FieldType::String, false),
        ],
    );

    let _ = db.new_collection(
        "user_joined_groups",
        vec![
            ("user_id", FieldType::String, false),
            ("group_id", FieldType::String, false),
            ("host", FieldType::String, false),
            ("name", FieldType::String, false),
            ("joined_at", FieldType::String, false),
        ],
    );

    let _ = db.new_collection(
        "device_keys",
        vec![
            ("key_id", FieldType::String, true),
            ("user_handle", FieldType::String, false),
            ("public_key", FieldType::String, false),
            ("device_name", FieldType::String, false),
            ("created_at", FieldType::String, false),
            ("last_used_at", FieldType::String, false),
            ("revoked", FieldType::String, false),
        ],
    );

    // Presence collection - stores user availability and status
    let _ = db.new_collection(
        "presence",
        vec![
            ("user_handle", FieldType::String, true),
            ("availability", FieldType::String, false),
            ("status", FieldType::String, false),
            ("last_seen", FieldType::String, false),
            ("metadata", FieldType::String, false), // JSON serialized
            ("updated_at", FieldType::String, false),
        ],
    );

    // Privacy settings collection
    let _ = db.new_collection(
        "privacy_settings",
        vec![
            ("user_handle", FieldType::String, true),
            ("presence_visibility", FieldType::String, false),
            ("profile_visibility", FieldType::String, false),
            ("membership_visibility", FieldType::String, false),
            ("updated_at", FieldType::String, false),
        ],
    );

    db
}
