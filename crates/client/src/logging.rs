//! Cross-platform logging module.
//!
//! Provides unified logging macros that dispatch to the appropriate backend:
//! - Web: `web_sys::console`
//! - Desktop: `tracing` crate

/// Log an info message (platform-specific)
#[cfg(target_arch = "wasm32")]
pub fn log_info_impl(msg: &str) {
    web_sys::console::log_1(&msg.into());
}

#[cfg(not(target_arch = "wasm32"))]
pub fn log_info_impl(msg: &str) {
    tracing::info!("{}", msg);
}

/// Log an error message (platform-specific)
#[cfg(target_arch = "wasm32")]
pub fn log_error_impl(msg: &str) {
    web_sys::console::error_1(&msg.into());
}

#[cfg(not(target_arch = "wasm32"))]
pub fn log_error_impl(msg: &str) {
    tracing::error!("{}", msg);
}

/// Log a warning message (platform-specific)
#[cfg(target_arch = "wasm32")]
pub fn log_warn_impl(msg: &str) {
    web_sys::console::warn_1(&msg.into());
}

#[cfg(not(target_arch = "wasm32"))]
pub fn log_warn_impl(msg: &str) {
    tracing::warn!("{}", msg);
}

/// Log a debug message (platform-specific)
#[cfg(target_arch = "wasm32")]
pub fn log_debug_impl(msg: &str) {
    web_sys::console::debug_1(&msg.into());
}

#[cfg(not(target_arch = "wasm32"))]
pub fn log_debug_impl(msg: &str) {
    tracing::debug!("{}", msg);
}

/// Log an info message
#[macro_export]
macro_rules! log_info {
    ($($arg:tt)*) => {
        $crate::logging::log_info_impl(&format!($($arg)*))
    };
}

/// Log an error message
#[macro_export]
macro_rules! log_error {
    ($($arg:tt)*) => {
        $crate::logging::log_error_impl(&format!($($arg)*))
    };
}

/// Log a warning message
#[macro_export]
macro_rules! log_warn {
    ($($arg:tt)*) => {
        $crate::logging::log_warn_impl(&format!($($arg)*))
    };
}

/// Log a debug message
#[macro_export]
macro_rules! log_debug {
    ($($arg:tt)*) => {
        $crate::logging::log_debug_impl(&format!($($arg)*))
    };
}
