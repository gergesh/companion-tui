# Architecture Analysis: Dual TUI + Web UI for Claude Code

## Problem

Claude Code currently supports either a TUI (interactive terminal) or programmatic access
via the Agent SDK. There's no supported way to have both a TUI and a web UI observing and
interacting with the same session simultaneously.

## Key Components

### Claude Code's `--sdk-url` Flag

A hidden CLI flag that transforms Claude Code from an interactive TUI into a WebSocket
client. When set:

- Claude Code connects TO the specified WebSocket URL (it acts as a client)
- All communication uses NDJSON (newline-delimited JSON)
- The TUI is completely disabled
- Only works with `-p` (print mode) + `--output-format stream-json`

Message types: `system/init`, `assistant`, `user`, `result`, `stream_event`,
`control_request` (permission prompts), `control_response` (permission answers),
`keep_alive`, `tool_progress`.

### Companion (The Vibe Company)

A production-grade WebSocket bridge server + React web UI:

```
Claude Code CLI ──(--sdk-url ws://localhost:3456/ws/cli/:id)──> Companion Server
                                                                      │
Browser ──────────(ws://localhost:3456/ws/browser/:id)─────────────────┘
```

- Spawns/manages Claude Code CLI processes
- Bridges NDJSON messages between CLI and browser WebSocket clients
- Full session management, persistence, reconnection
- Permission gating UI
- Built on Bun + Hono (server) and React 19 + Zustand (frontend)

### Pi-TUI (badlogic/pi-mono)

A high-performance terminal UI framework:

- Component-based: Text, Editor, Markdown, SelectList, Image, etc.
- Abstract `Terminal` interface (ProcessTerminal for real TTY, VirtualTerminal for testing)
- Differential rendering with synchronized output (no flicker)
- Kitty keyboard protocol support
- Backend-agnostic: the TUI layer has no AI dependencies

Pi-mono also includes `pi-agent-core` (agent runtime) and `pi-ai` (multi-provider LLM API),
but those are separate packages.

### Claude Agent SDK

Official SDK (`@anthropic-ai/claude-agent-sdk`):

- Spawns Claude Code CLI as subprocess
- Communicates via NDJSON over stdio
- `query()` for one-shot, `ClaudeSDKClient` for stateful bidirectional sessions
- ~12 second startup overhead per session
- Abstracts the NDJSON protocol into typed message objects

---

## Approaches

### Approach A: Companion as Hub + TUI as WebSocket Client

```
Claude Code CLI ──(--sdk-url)──> Companion Server ──ws──> Browser (Web UI)
                                        │
                                        └──ws──> TUI Client
```

**How it works:**
- Companion runs as-is, spawning Claude Code with `--sdk-url`
- Browser connects to `ws://localhost:3456/ws/browser/:sessionId` (existing)
- We build a TUI that also connects to `ws://localhost:3456/ws/browser/:sessionId`
- Both interfaces see the same messages and can send prompts

**Pros:**
- Minimal new code. Companion handles all protocol complexity.
- Web UI is fully functional out of the box.
- Session management, persistence, reconnection are solved.
- Can run multiple TUI + browser clients per session.

**Cons:**
- Depends on Companion's browser WebSocket protocol (not officially stable).
- Two-hop latency: CLI → Server → TUI.
- Must run Companion server as a dependency.
- TUI UX limited by what Companion exposes (e.g., permission flow).

**Complexity:** Low
**Recommended for:** Quick proof of concept, immediate usability.

---

### Approach B: Custom NDJSON Server + Both UIs

```
Claude Code CLI ──(--sdk-url)──> Custom Server ──ws──> Web UI
                                      │
                                      └────────> TUI (in-process)
```

**How it works:**
- Build a lightweight WebSocket server that speaks Claude Code's NDJSON protocol.
- Server accepts the CLI connection on one endpoint.
- Server runs the TUI in-process (same Node/Bun process).
- Server also exposes a WebSocket endpoint for browser clients.
- Messages are broadcast to all connected interfaces.

**Pros:**
- Full control over the protocol and UX.
- TUI runs in-process: zero latency for rendering.
- No external dependencies (no Companion needed).
- Can optimize the server for exactly this use case.

**Cons:**
- Must implement NDJSON protocol handling (parsing, keep-alive, reconnection).
- Must build or integrate a web UI.
- Must handle permission flow for both interfaces.
- More code to maintain.

**Complexity:** Medium
**Recommended for:** Production-quality solution with tight integration.

---

### Approach C: Agent SDK as Core + Dual Interfaces

```
                                 ┌──> TUI (pi-tui)
Agent SDK (ClaudeSDKClient) ─────┤
                                 └──> Web UI (via WebSocket server)
```

**How it works:**
- Use `ClaudeSDKClient` from the Agent SDK to create a session.
- The SDK manages the subprocess (Claude Code CLI) and NDJSON protocol.
- Build an event bus that broadcasts SDK messages to both TUI and web UI.
- TUI renders in-process, web UI connects via WebSocket.

**Pros:**
- Uses official, supported SDK.
- Clean abstraction: we don't parse NDJSON ourselves.
- SDK handles subprocess lifecycle, reconnection, etc.
- Future-proof: will track Claude Code updates.

**Cons:**
- Agent SDK spawns CLI as subprocess (not WebSocket), so we can't attach
  additional clients directly to the CLI stream.
- 12-second startup overhead.
- Must bridge SDK events to WebSocket ourselves.
- SDK is still early (v0.0.25 Python, similarly early for TS).

**Complexity:** Medium
**Recommended for:** Forward-looking solution using official APIs.

---

### Approach D: Extend Companion with Integrated TUI

```
Companion Server ──spawns──> Claude Code CLI (--sdk-url)
       │
       ├──ws──> Browser (existing)
       │
       └──────> Integrated TUI (in same process)
```

**How it works:**
- Fork Companion.
- Add a `--tui` mode that starts a terminal interface alongside the server.
- TUI connects to the internal message bus (no WebSocket needed for TUI).
- Browser clients still connect via WebSocket as usual.

**Pros:**
- All-in-one solution: single process, single command.
- TUI has direct access to server state (no WebSocket overhead).
- Leverages Companion's existing session management and protocol handling.
- Could be contributed upstream.

**Cons:**
- Requires forking and maintaining a Companion fork.
- Companion is a complex codebase; adding TUI mode is non-trivial.
- Process model conflict: Companion is a server, TUI wants to own stdin/stdout.

**Complexity:** High
**Recommended for:** Polished, integrated product.

---

### Approach E: Custom TUI Speaking `--sdk-url` Protocol Directly

```
Custom TUI ──(acts as --sdk-url server)──> Claude Code CLI
    │
    └──ws──> Browser (optional web viewer)
```

**How it works:**
- Build a WebSocket server that understands Claude Code's NDJSON protocol.
- Spawn Claude Code CLI with `--sdk-url ws://localhost:PORT/ws/cli`.
- The TUI is the primary interface, running in-process.
- Optionally expose a read-only (or interactive) web viewer.

**Pros:**
- TUI-first design: optimal terminal experience.
- Full control over the protocol and rendering.
- No Companion dependency.
- Simplest mental model: TUI IS the server.

**Cons:**
- Must implement the NDJSON server protocol (messages, permissions, keep-alive).
- Web UI is secondary and must be built separately.
- Must handle all edge cases (reconnection, session persistence).

**Complexity:** Medium-High
**Recommended for:** TUI-centric workflow with optional web viewing.

---

## Recommendation

**Start with Approach A** (Companion as Hub + TUI client) for immediate usability:
- Install Companion, build a thin TUI client that connects as a browser.
- This validates the concept with minimal code (~200 lines).
- The TUI only needs to: connect WebSocket, render messages, send prompts, handle permissions.

**Graduate to Approach B or E** for production:
- Build our own NDJSON server for tighter integration.
- Use pi-tui components for the terminal rendering.
- Add a web UI (possibly borrowing from Companion's React components).

**Consider Approach C** if the Agent SDK matures:
- The SDK abstracts away protocol details.
- Once startup overhead is reduced and the API stabilizes, this becomes the cleanest path.

---

## NDJSON Protocol Reference

### Messages from CLI (received by server)

| Type | Subtype | Description |
|------|---------|-------------|
| `system` | `init` | Session metadata, capabilities, tools, model info |
| `assistant` | - | Claude's response (text blocks, tool_use blocks) |
| `user` | - | Tool results (tool_result blocks) |
| `result` | `success`/`error` | Query completion with cost, duration, session_id |
| `stream_event` | - | Token-level streaming (content_block_start/delta/stop) |
| `control_request` | `can_use_tool` | Permission prompt for tool execution |
| `keep_alive` | - | Heartbeat |
| `tool_progress` | - | Tool execution progress |

### Messages to CLI (sent by server)

| Type | Description |
|------|-------------|
| `user` | User prompt (content string or content blocks) |
| `control_response` | Permission response (allow/deny) for control_request |

### Companion Browser WebSocket Protocol

Messages from server to browser are JSON (not NDJSON) with types like:
- `session_init` - Session created/initialized
- `cli_message` - Wrapped CLI NDJSON message
- `session_status` - Session lifecycle updates
- `error` - Error messages

Messages from browser to server:
- `user_message` - User prompt
- `permission_response` - Allow/deny tool execution
- `interrupt` - Cancel current operation
