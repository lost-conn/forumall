# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Forumall is a Rust-based OFSCP (Open Federated Social Communications Protocol) provider and chat application. The project is structured as a **Cargo workspace** with three main crates:

- **forumall-shared**: Common types, protocol definitions, and utilities
- **forumall-server**: Pure Axum HTTP/WebSocket server
- **forumall-client**: Dioxus web application

> **Note**: The `src/` directory contains legacy Dioxus fullstack code that is being migrated to the new workspace structure. The new crates in `crates/` are the active implementation.

## Project Structure

```
forumall/
├── Cargo.toml              # Workspace root (also legacy package, ignore)
├── crates/
│   ├── shared/             # forumall-shared: Types and protocol
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── models.rs   # All shared types
│   │       ├── protocol.rs # OFSCP signature/verification
│   │       └── error.rs    # Error types including ProblemDetails
│   │
│   ├── server/             # forumall-server: Axum server
│   │   └── src/
│   │       ├── main.rs     # Server entrypoint
│   │       ├── db.rs       # Aurora DB initialization
│   │       ├── state.rs    # AppState
│   │       ├── routes/     # API endpoints
│   │       ├── middleware/ # OFSCP signature verification
│   │       └── ws.rs       # WebSocket handler
│   │
│   └── client/             # forumall-client: Dioxus app
│       └── src/
│           ├── main.rs     # App entrypoint
│           ├── api_client.rs
│           ├── auth_session.rs
│           ├── client_keys.rs
│           ├── ws_manager.rs
│           ├── views/
│           └── components/
│
├── src/                    # LEGACY - being migrated
└── MIGRATION_PLAN.md       # Detailed migration guide
```

## Build Commands

```bash
# Build the server
cargo build -p forumall-server

# Build the client (for development)
cd crates/client && dx serve

# Build the server (release)
cargo build -p forumall-server --release

# Run the server
cargo run -p forumall-server

# Lint
cargo clippy -p forumall-shared -p forumall-server -p forumall-client

# Run tests
cargo test -p forumall-shared -p forumall-server
```

## Architecture

### Workspace Crates

| Crate | Purpose |
|-------|---------|
| `forumall-shared` | Types, OFSCP protocol, error handling - used by both server and client |
| `forumall-server` | Pure Axum server with all API endpoints and WebSocket support |
| `forumall-client` | Dioxus web app that can connect to any OFSCP provider |

### Server Architecture (forumall-server)

- **Axum router** with standard route handlers (not Dioxus server functions)
- **Aurora DB** for storage (embedded NoSQL)
- **OFSCP signature verification** via custom extractors (`SignedJson`, `SignedRequest`)
- **WebSocket** support for real-time messaging

### Client Architecture (forumall-client)

- **Dioxus** for UI (router, signals, components)
- **ApiClient** for HTTP requests with OFSCP signing
- **Provider URL** configurable to connect to any OFSCP server
- **WsManager** for WebSocket connections

### OFSCP Protocol

All authenticated API requests require Ed25519 signatures with these headers:
- `X-OFSCP-Signature`: `keyId="...", signature="..."`
- `X-OFSCP-Actor`: User identifier (`@handle@domain`)
- `X-OFSCP-Timestamp`: ISO 8601 timestamp

### Database

Aurora DB (embedded NoSQL) with collections:
- `users`, `groups`, `group_members`, `channels`, `messages`, `device_keys`, `idempotency_keys`, `user_joined_groups`

### Routes (Server)

```
/                                              Landing (client serves)
/.well-known/ofscp-provider                    OFSCP discovery
/.well-known/ofscp/users/{handle}/keys         Public key discovery

/api/auth/register                             POST - Registration
/api/auth/login                                POST - Login
/api/auth/device-keys                          POST/GET - Device key management

/api/groups                                    POST/GET - Groups
/api/groups/{group_id}                         GET/PUT - Group details
/api/groups/{group_id}/join                    POST - Join group
/api/groups/{group_id}/channels                POST/GET - Channels
/api/groups/{group_id}/channels/{id}/messages  POST/GET - Messages

/api/users/{handle}/profile                    GET - User profile
/api/users/{user_id}/groups                    GET/POST - User's groups
/api/me/groups                                 POST - Add self to group

/api/ws                                        WebSocket endpoint
```

## Development Workflow

1. **Run the server**:
   ```bash
   cargo run -p forumall-server
   ```
   Server runs on `http://localhost:8080`

2. **Build Tailwind CSS** (required before running client):
   ```bash
   cd crates/client
   npm run css:watch
   ```
   Run this in a separate terminal to rebuild CSS when classes change. Use `npm run css` for a one-time build.

3. **Run the client** (separate terminal):
   ```bash
   cd crates/client
   dx serve
   ```
   Client runs on `http://localhost:8081` (or similar)

4. **Configure client to connect to server**:
   The client reads `provider_domain` from localStorage or defaults to current origin.

## Migration Status

The migration from Dioxus fullstack to separated server/client is in progress:

- ✅ Shared crate created with all types
- ✅ Server crate with Axum routes
- ✅ Client crate skeleton with auth, API client, WS manager
- ⏳ Views need to be copied from `src/views/` to `crates/client/src/views/`
- ⏳ Components need to be copied
- ⏳ Legacy `src/` can be removed once migration complete

See `MIGRATION_PLAN.md` for detailed migration steps.
