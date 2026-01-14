# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Forumall is a Rust-based OFSCP (Open Federated Social Communications Protocol) provider and chat application built with **Dioxus fullstack**. It's the reference implementation for the OFSCP federation protocol, designed to be self-hostable.

## Build Commands

```bash
# Development (web + server, the default)
dx serve

# Production build
dx build --release

# Run tests
cargo test

# Lint
cargo clippy

# Build specific targets
cargo build --features server          # Server only
cargo build --features desktop         # Desktop app
cargo build --features mobile          # Mobile app
```

## Architecture

### Unified Codebase Pattern

This is a **fullstack Rust application** where the same codebase compiles to:
- Server (Axum) via `--features server`
- Web client (WASM) via `--features web`
- Desktop/Mobile via respective features

Code is conditionally compiled using `#[cfg(feature = "...")]` attributes.

### Server Functions

Dioxus fullstack uses annotated functions that automatically become HTTP endpoints on the server and RPC calls on the client:

```rust
#[post("/api/auth/register")]
async fn register(Json(req): Json<RegisterRequest>) -> Result<Json<User>> { ... }
```

The `#[get]`, `#[post]`, `#[put]` macros from `dioxus_fullstack` handle routing and serialization.

### Key Modules

| Module | Purpose |
|--------|---------|
| `auth.rs` | Registration/login endpoints, Argon2 password hashing |
| `auth_session.rs` | Client-side auth context (Signal-based reactive state) |
| `auth/client_keys.rs` | Ed25519 key generation for OFSCP request signing |
| `api_client.rs` | HTTP client that signs requests per OFSCP spec |
| `groups.rs` | Group/channel CRUD operations |
| `messages.rs` | Message creation with idempotency support |
| `ws_client.rs` | WebSocket client provider for real-time messaging |
| `server/signature.rs` | OFSCP signature verification middleware |
| `server/ws.rs` | WebSocket server handler |

### State Management

Dioxus uses **Signals** for reactive state (not React-style hooks):

```rust
let auth = use_context::<AuthContext>();
let count: Signal<i32> = use_signal(|| 0);
```

Auth and WebSocket contexts are provided at the app root in `main.rs`.

### OFSCP Protocol

All authenticated API requests require Ed25519 signatures with these headers:
- `X-OFSCP-Signature`: Base64-encoded signature
- `X-OFSCP-Actor`: User identifier (`handle@domain`)
- `X-OFSCP-Timestamp`: ISO 8601 timestamp

The client generates keys in `auth/client_keys.rs` and signs via `api_client.rs`.

### Database

Aurora DB (embedded NoSQL) with collections defined in `main.rs`:
- `users`, `groups`, `group_members`, `channels`, `messages`, `device_keys`, `idempotency_keys`, `user_joined_groups`

Access via the global `DB` static: `crate::DB.collection("users")`

### Routes

```
/                           Landing page
/login, /register           Auth pages
/home                       Dashboard (no group selected)
/home/:group                Group view (no channel selected)
/home/:group/:channel       Channel chat view
/test-ws                    WebSocket debug page
/.well-known/ofscp-provider OFSCP discovery endpoint
```

## Current Status

Auth system is under active development (see recent commits). WebSocket authentication is not fully implemented yet.
