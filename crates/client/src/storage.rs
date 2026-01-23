//! Cross-platform storage module.
//!
//! Provides a unified API for persistent storage:
//! - Web: `localStorage`
//! - Desktop: JSON files in the platform-appropriate config directory:
//!   - Linux: `~/.config/forumall/`
//!   - macOS: `~/Library/Application Support/forumall/`
//!   - Windows: `%APPDATA%\forumall\`

use serde::{de::DeserializeOwned, Serialize};

/// Save a value to persistent storage.
///
/// Returns `true` if the operation succeeded.
pub fn save<T: Serialize>(key: &str, value: &T) -> bool {
    match serde_json::to_string(value) {
        Ok(json) => save_raw(key, &json),
        Err(_) => false,
    }
}

/// Load a value from persistent storage.
///
/// Returns `None` if the key doesn't exist or deserialization fails.
pub fn load<T: DeserializeOwned>(key: &str) -> Option<T> {
    let json = load_raw(key)?;
    serde_json::from_str(&json).ok()
}

/// Remove a value from persistent storage.
pub fn remove(key: &str) {
    remove_raw(key);
}

/// Check if a key exists in storage.
pub fn exists(key: &str) -> bool {
    load_raw(key).is_some()
}

// =========================================
// Web (WASM) implementation
// =========================================

#[cfg(target_arch = "wasm32")]
fn save_raw(key: &str, value: &str) -> bool {
    if let Some(window) = web_sys::window() {
        if let Ok(Some(storage)) = window.local_storage() {
            return storage.set_item(key, value).is_ok();
        }
    }
    false
}

#[cfg(target_arch = "wasm32")]
fn load_raw(key: &str) -> Option<String> {
    let window = web_sys::window()?;
    let storage = window.local_storage().ok()??;
    storage.get_item(key).ok()?
}

#[cfg(target_arch = "wasm32")]
fn remove_raw(key: &str) {
    if let Some(window) = web_sys::window() {
        if let Ok(Some(storage)) = window.local_storage() {
            let _ = storage.remove_item(key);
        }
    }
}

// =========================================
// Desktop (native) implementation
// =========================================

#[cfg(not(target_arch = "wasm32"))]
fn get_config_dir() -> Option<std::path::PathBuf> {
    let config_dir = dirs::config_dir()?;
    let app_dir = config_dir.join("forumall");

    // Ensure the directory exists
    if !app_dir.exists() {
        std::fs::create_dir_all(&app_dir).ok()?;
    }

    Some(app_dir)
}

#[cfg(not(target_arch = "wasm32"))]
fn get_file_path(key: &str) -> Option<std::path::PathBuf> {
    let config_dir = get_config_dir()?;
    // Sanitize key to be a valid filename
    let safe_key = key.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");
    Some(config_dir.join(format!("{}.json", safe_key)))
}

#[cfg(not(target_arch = "wasm32"))]
fn save_raw(key: &str, value: &str) -> bool {
    let Some(path) = get_file_path(key) else {
        return false;
    };
    std::fs::write(path, value).is_ok()
}

#[cfg(not(target_arch = "wasm32"))]
fn load_raw(key: &str) -> Option<String> {
    let path = get_file_path(key)?;
    std::fs::read_to_string(path).ok()
}

#[cfg(not(target_arch = "wasm32"))]
fn remove_raw(key: &str) {
    if let Some(path) = get_file_path(key) {
        let _ = std::fs::remove_file(path);
    }
}
