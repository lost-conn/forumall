//! View components for the application.

pub mod channel_view;
pub mod home;
pub mod layouts;
pub mod login;
pub mod profile_view;
pub mod register;

pub use channel_view::ChannelView;
pub use home::{
    ChannelList, CreateChannelModal, CreateGroupModal, GroupErrorKind, GroupErrorView,
    GroupSettingsModal, Home, JoinGroupModal, NoChannel, NoGroup,
};
pub use layouts::{GroupSidebarLayout, HomeSidebarLayout};
pub use login::Login;
pub use profile_view::ProfileView;
pub use register::Register;
