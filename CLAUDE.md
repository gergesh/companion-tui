# ccpi - Claude Code Parallel Interface

Dual TUI + Web UI for Claude Code sessions.

## Architecture

See ARCHITECTURE.md for the full analysis of approaches.

## Stack

- Runtime: Bun
- Language: TypeScript
- TUI: pi-tui (@mariozechner/pi-tui) from pi-mono
- Web UI / Server: Companion (the-companion)
- Protocol: NDJSON over WebSocket (Claude Code's `--sdk-url` protocol)

## Development

```bash
bun install
bun run poc/companion-tui.ts   # PoC: TUI client for Companion
```
