//! Message display components for different message types.
//!
//! - `MemoItem`: Post-style card layout for memo messages
//! - `ArticleItem`: Collapsed forum-style with title+snippet
//! - `ArticleModal`: Full article view in a modal overlay

pub mod memo_item;
pub mod article_item;
pub mod article_modal;

pub use memo_item::MemoItem;
pub use article_item::ArticleItem;
pub use article_modal::ArticleModal;
