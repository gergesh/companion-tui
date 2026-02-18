#!/usr/bin/env bun
// ccpi TUI - Terminal client for Companion server
// Connects as a "browser" client via WebSocket to share sessions with the web UI

import chalk from "chalk";
import {
  TUI,
  ProcessTerminal,
  Editor,
  Markdown,
  Text,
  Spacer,
  Loader,
  SelectList,
  matchesKey,
  type Component,
  type SelectItem,
  CURSOR_MARKER,
} from "@mariozechner/pi-tui";
import {
  CompanionClient,
  createSession,
  listSessions,
  getSession,
  relaunchSession,
  type ConnectionStatus,
  type SessionInfo,
} from "./companion-client.ts";
import type {
  ServerMessage,
  ContentBlock,
  PermissionRequest,
  SessionState,
} from "./types.ts";

// -- Themes ------------------------------------------------------------------

const selectListTheme = {
  selectedPrefix: (t: string) => chalk.blue(t),
  selectedText: (t: string) => chalk.bold(t),
  description: (t: string) => chalk.dim(t),
  scrollInfo: (t: string) => chalk.dim(t),
  noMatch: (t: string) => chalk.dim(t),
};

const markdownTheme = {
  heading: (t: string) => chalk.bold.cyan(t),
  link: (t: string) => chalk.blue(t),
  linkUrl: (t: string) => chalk.dim(t),
  code: (t: string) => chalk.yellow(t),
  codeBlock: (t: string) => chalk.green(t),
  codeBlockBorder: (t: string) => chalk.dim(t),
  quote: (t: string) => chalk.italic(t),
  quoteBorder: (t: string) => chalk.dim(t),
  hr: (t: string) => chalk.dim(t),
  listBullet: (t: string) => chalk.cyan(t),
  bold: (t: string) => chalk.bold(t),
  italic: (t: string) => chalk.italic(t),
  strikethrough: (t: string) => chalk.strikethrough(t),
  underline: (t: string) => chalk.underline(t),
};

const editorTheme = {
  borderColor: (t: string) => chalk.dim(t),
  selectList: selectListTheme,
};

// -- Permission Banner -------------------------------------------------------

class PermissionBanner implements Component {
  focused = false;
  private request: PermissionRequest;
  private onRespond: (behavior: "allow" | "deny") => void;
  private tui: TUI;

  constructor(
    tui: TUI,
    request: PermissionRequest,
    onRespond: (behavior: "allow" | "deny") => void,
  ) {
    this.tui = tui;
    this.request = request;
    this.onRespond = onRespond;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const r = this.request;
    const inputStr = formatToolInput(r.tool_name, r.input);
    const lines = [
      "",
      chalk.bgYellow.black(` PERMISSION REQUEST `),
      chalk.yellow(`Tool: ${r.tool_name}`),
    ];
    if (inputStr) {
      for (const line of inputStr.split("\n").slice(0, 10)) {
        lines.push(chalk.dim(`  ${line}`));
      }
      if (inputStr.split("\n").length > 10) {
        lines.push(chalk.dim(`  ... (truncated)`));
      }
    }
    lines.push("");
    lines.push(
      `  ${chalk.green("[y] Allow")}  ${chalk.red("[n] Deny")}  ${chalk.blue("[a] Always allow")}`,
    );
    lines.push("");
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "y") || matchesKey(data, "enter")) {
      this.onRespond("allow");
    } else if (matchesKey(data, "n") || matchesKey(data, "escape")) {
      this.onRespond("deny");
    } else if (matchesKey(data, "a")) {
      // "always allow" -- for now same as allow, could add rule update later
      this.onRespond("allow");
    }
  }
}

// -- Status Bar --------------------------------------------------------------

class StatusBar implements Component {
  connectionStatus: ConnectionStatus = "disconnected";
  session: SessionState | null = null;
  isRunning = false;

  invalidate(): void {}

  render(width: number): string[] {
    const parts: string[] = [];

    // Connection indicator
    const connIcon =
      this.connectionStatus === "connected"
        ? chalk.green("●")
        : this.connectionStatus === "connecting"
          ? chalk.yellow("●")
          : chalk.red("●");
    parts.push(connIcon);

    if (this.session) {
      parts.push(chalk.dim(this.session.model));
      if (this.session.total_cost_usd > 0) {
        parts.push(
          chalk.dim(`$${this.session.total_cost_usd.toFixed(4)}`),
        );
      }
      if (this.session.context_used_percent > 0) {
        parts.push(
          chalk.dim(`ctx:${this.session.context_used_percent}%`),
        );
      }
    }

    if (this.isRunning) {
      parts.push(chalk.cyan("⟳ running"));
    }

    const line = parts.join(chalk.dim(" │ "));
    return [chalk.bgBlack(` ${line} `.padEnd(width))];
  }
}

// -- Helpers -----------------------------------------------------------------

function formatToolInput(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName === "Bash" && typeof input.command === "string") {
    return `$ ${input.command}`;
  }
  if (
    (toolName === "Read" || toolName === "Write" || toolName === "Edit") &&
    typeof input.file_path === "string"
  ) {
    return input.file_path;
  }
  if (toolName === "Grep" && typeof input.pattern === "string") {
    return `grep ${input.pattern}`;
  }
  if (toolName === "Glob" && typeof input.pattern === "string") {
    return `glob ${input.pattern}`;
  }
  return JSON.stringify(input, null, 2);
}

function extractText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "tool_use") {
      parts.push(
        `\n${chalk.dim(`⚡ ${block.name}`)} ${chalk.dim(formatToolInput(block.name, block.input))}\n`,
      );
    } else if (block.type === "thinking") {
      parts.push(chalk.dim.italic(`💭 ${block.thinking}`));
    }
  }
  return parts.join("");
}

// -- Main App ----------------------------------------------------------------

// -- CLI Args ----------------------------------------------------------------

interface CliArgs {
  continue: boolean;
  resume: boolean;
  resumeId?: string;
  help: boolean;
  host: string;
}

function parseCliArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const args: CliArgs = {
    continue: false,
    resume: false,
    help: false,
    host: process.env.COMPANION_HOST ?? "localhost:3456",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "-c" || arg === "--continue") {
      args.continue = true;
    } else if (arg === "-r" || arg === "--resume") {
      args.resume = true;
      // Peek at next arg: if it exists and doesn't start with -, it's the session ID
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        args.resumeId = next;
        i++;
      }
    } else if (arg === "--host") {
      const next = argv[++i];
      if (!next) {
        console.error(chalk.red("--host requires a value"));
        process.exit(1);
      }
      args.host = next;
    } else {
      console.error(chalk.red(`Unknown argument: ${arg}`));
      printUsage();
      process.exit(1);
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`${chalk.bold("ccpi")} — TUI client for Claude Code via Companion

${chalk.dim("Usage:")}
  ccpi                         Connect to a running session, or create one
  ccpi -c                      Resume the most recent session (relaunch if exited)
  ccpi -r                      Pick a session to resume interactively
  ccpi -r <session-id>         Resume a specific session by ID (prefix match)

${chalk.dim("Options:")}
  -c, --continue               Resume the most recent session
  -r, --resume [id]            Resume a session (interactive picker if no ID)
  -h, --help                   Show this help
  --host <host:port>           Companion server (default: localhost:3456)
`);
}

// -- Session Resolution ------------------------------------------------------

function isAlive(s: SessionInfo): boolean {
  return s.state === "connected" || s.state === "running" || s.state === "idle";
}

async function ensureAlive(
  host: string,
  session: SessionInfo,
): Promise<void> {
  if (isAlive(session)) return;
  console.log(
    chalk.dim(`Session ${session.sessionId.slice(0, 8)} is ${session.state}, relaunching...`),
  );
  await relaunchSession(host, session.sessionId);
  await new Promise((r) => setTimeout(r, 2000));
}

function findByPrefix(
  sessions: SessionInfo[],
  prefix: string,
): SessionInfo | undefined {
  const exact = sessions.find((s) => s.sessionId === prefix);
  if (exact) return exact;
  const matches = sessions.filter((s) => s.sessionId.startsWith(prefix));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.error(chalk.red(`Ambiguous session prefix "${prefix}", matches:`));
    for (const m of matches) {
      console.error(chalk.dim(`  ${m.sessionId.slice(0, 8)}  ${m.state}  ${m.cwd}`));
    }
    process.exit(1);
  }
  return undefined;
}

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function sessionLabel(s: SessionInfo): string {
  const stateIcon = isAlive(s) ? chalk.green("●") : chalk.dim("○");
  const id = s.sessionId.slice(0, 8);
  const age = s.createdAt ? timeAgo(s.createdAt) : "";
  const title = s.name ?? s.cwd.replace(/^\/Users\/[^/]+\//, "~/");
  return `${stateIcon} ${chalk.bold(title)}`;
}

function sessionDescription(s: SessionInfo): string {
  // Shown dim to the right of the label; also used for type-to-filter
  const id = s.sessionId.slice(0, 8);
  const age = s.createdAt ? timeAgo(s.createdAt) : "";
  return `${id} ${age}`;
}

/** Show an interactive session picker using pi-tui SelectList. */
function pickSession(sessions: SessionInfo[]): Promise<SessionInfo | null> {
  return new Promise((resolve) => {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal);

    const header = new Text(
      chalk.bold("Select a session to resume") +
        chalk.dim("  (type to filter, Enter to select, Esc to cancel)"),
      1,
      0,
    );

    // Sort most recent first
    const sorted = [...sessions].sort(
      (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
    );

    const items: SelectItem[] = sorted.map((s) => ({
      label: sessionLabel(s),
      value: s.sessionId,
      description: sessionDescription(s),
    }));

    const list = new SelectList(items, Math.min(items.length, 20), selectListTheme);

    list.onSelect = (item: SelectItem) => {
      tui.stop();
      const session = sessions.find((s) => s.sessionId === item.value);
      resolve(session ?? null);
    };

    list.onCancel = () => {
      tui.stop();
      resolve(null);
    };

    tui.addChild(header);
    tui.addChild(new Spacer(1));
    tui.addChild(list);
    tui.setFocus(list);
    tui.start();
  });
}

// -- Main App ----------------------------------------------------------------

async function main() {
  const args = parseCliArgs();

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const host = args.host;

  // Resolve session
  const cwd = process.cwd();
  let sessionId: string;
  try {
    const allSessions = await listSessions(host);
    // Filter to current directory for browsing/auto-selection
    const localSessions = allSessions.filter((s) => s.cwd === cwd);

    if (args.resume) {
      if (args.resumeId) {
        // --resume <id>: explicit ID -- search ALL sessions (user knows what they want)
        const session = findByPrefix(allSessions, args.resumeId);
        if (!session) {
          console.error(
            chalk.red(`No session found matching "${args.resumeId}"`),
          );
          const recent = allSessions
            .filter((s) => s.cwd === cwd)
            .slice(-10);
          if (recent.length > 0) {
            console.error(chalk.dim("Sessions in this directory:"));
            for (const s of recent) {
              console.error(
                chalk.dim(
                  `  ${s.sessionId.slice(0, 8)}  ${s.state.padEnd(10)}  ${s.name ?? s.cwd}`,
                ),
              );
            }
          }
          process.exit(1);
        }
        await ensureAlive(host, session);
        sessionId = session.sessionId;
        console.log(
          chalk.dim(`Resuming session ${sessionId.slice(0, 8)}...`),
        );
      } else {
        // --resume (no id): interactive picker scoped to cwd
        if (localSessions.length === 0) {
          console.error(
            chalk.red(`No sessions in ${cwd}`),
          );
          process.exit(1);
        }
        const picked = await pickSession(localSessions);
        if (!picked) {
          process.exit(0);
        }
        await ensureAlive(host, picked);
        sessionId = picked.sessionId;
      }
    } else if (args.continue) {
      // --continue: most recent session in this directory
      if (localSessions.length === 0) {
        console.error(chalk.red(`No sessions to continue in ${cwd}`));
        process.exit(1);
      }
      const sorted = [...localSessions].sort(
        (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
      );
      const session = sorted[0]!;
      await ensureAlive(host, session);
      sessionId = session.sessionId;
      console.log(
        chalk.dim(
          `Continuing session ${sessionId.slice(0, 8)}${session.name ? ` (${session.name})` : ""}...`,
        ),
      );
    } else {
      // Default: connect to a live session in this directory, or create one
      const alive = localSessions.filter(isAlive);
      if (alive.length > 0) {
        sessionId = alive[0]!.sessionId;
        console.log(
          chalk.dim(
            `Connecting to session ${sessionId.slice(0, 8)}...`,
          ),
        );
      } else {
        console.log(chalk.dim("Creating new session..."));
        const result = await createSession(host, { cwd });
        sessionId = result.sessionId;
        console.log(
          chalk.dim(`Created session ${sessionId.slice(0, 8)}`),
        );
      }
    }
  } catch (e) {
    console.error(
      chalk.red(
        `Cannot connect to Companion at ${host}. Is it running?`,
      ),
    );
    console.error(chalk.dim(`Start it with: bunx the-companion`));
    process.exit(1);
  }

  // Set up TUI
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const statusBar = new StatusBar();
  const editor = new Editor(tui, editorTheme);

  // Streaming state
  let streamingText = "";
  let streamingMd: Markdown | null = null;
  let loader: Loader | null = null;
  let permissionBanner: PermissionBanner | null = null;

  // Insert a component before the editor (which is always last)
  function insertBeforeEditor(component: Component): void {
    const idx = tui.children.indexOf(editor);
    if (idx >= 0) {
      tui.children.splice(idx, 0, component);
    } else {
      tui.addChild(component);
    }
  }

  // Remove loader if present
  function removeLoader(): void {
    if (loader) {
      tui.removeChild(loader);
      loader.stop();
      loader = null;
    }
  }

  // Finalize the current streaming markdown block
  function finalizeStream(): void {
    streamingText = "";
    streamingMd = null;
  }

  // Ensure a streaming markdown component exists
  function ensureStreamingMd(): Markdown {
    if (!streamingMd) {
      removeLoader();
      streamingMd = new Markdown("", 1, 0, markdownTheme);
      insertBeforeEditor(streamingMd);
    }
    return streamingMd;
  }

  // Handle messages from Companion
  function handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "session_init": {
        statusBar.session = msg.session;
        tui.requestRender();
        break;
      }

      case "session_update": {
        if (statusBar.session) {
          Object.assign(statusBar.session, msg.session);
        }
        tui.requestRender();
        break;
      }

      case "user_message": {
        // Show user messages (could be from web UI)
        const userMd = new Markdown(
          chalk.blue("You: ") + msg.content,
          1,
          0,
          markdownTheme,
        );
        insertBeforeEditor(userMd);
        insertBeforeEditor(new Spacer(1));
        tui.requestRender();
        break;
      }

      case "assistant": {
        finalizeStream();
        removeLoader();
        const text = extractText(msg.message.content);
        if (text.trim()) {
          const md = new Markdown(text, 1, 0, markdownTheme);
          insertBeforeEditor(md);
          insertBeforeEditor(new Spacer(1));
        }
        tui.requestRender();
        break;
      }

      case "stream_event": {
        const event = msg.event;
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            const md = ensureStreamingMd();
            streamingText += event.delta.text;
            md.setText(streamingText);
            tui.requestRender();
          } else if (event.delta.type === "thinking_delta") {
            // Could show thinking in a separate component
          }
        } else if (event.type === "content_block_stop") {
          // Block done, but more might come
        } else if (
          event.type === "message_stop" ||
          event.type === "message_delta"
        ) {
          finalizeStream();
        }
        break;
      }

      case "result": {
        finalizeStream();
        removeLoader();
        statusBar.isRunning = false;
        editor.disableSubmit = false;
        if (permissionBanner) {
          tui.removeChild(permissionBanner);
          permissionBanner = null;
          tui.setFocus(editor);
        }

        if (statusBar.session) {
          statusBar.session.total_cost_usd = msg.data.total_cost_usd;
          statusBar.session.num_turns = msg.data.num_turns;
        }

        if (msg.data.is_error && msg.data.errors?.length) {
          const errText = new Text(
            chalk.red(`Error: ${msg.data.errors.join(", ")}`),
            1,
            0,
          );
          insertBeforeEditor(errText);
        }

        insertBeforeEditor(new Spacer(1));
        tui.requestRender();
        break;
      }

      case "permission_request": {
        removeLoader();
        permissionBanner = new PermissionBanner(
          tui,
          msg.request,
          (behavior) => {
            client.sendPermissionResponse(msg.request.request_id, behavior);
            if (permissionBanner) {
              tui.removeChild(permissionBanner);
              permissionBanner = null;
            }
            // Show loader while tool executes
            loader = new Loader(
              tui,
              (s) => chalk.cyan(s),
              (s) => chalk.dim(s),
              `Running ${msg.request.tool_name}...`,
            );
            insertBeforeEditor(loader);
            loader.start();
            tui.setFocus(editor);
            tui.requestRender();
          },
        );
        insertBeforeEditor(permissionBanner);
        tui.setFocus(permissionBanner as unknown as Component);
        tui.requestRender();
        break;
      }

      case "permission_cancelled": {
        if (permissionBanner) {
          tui.removeChild(permissionBanner);
          permissionBanner = null;
          tui.setFocus(editor);
          tui.requestRender();
        }
        break;
      }

      case "tool_progress": {
        if (loader) {
          loader.setMessage(
            `Running ${msg.tool_name}... (${msg.elapsed_time_seconds.toFixed(0)}s)`,
          );
        }
        break;
      }

      case "status_change": {
        statusBar.isRunning = msg.status === "running";
        if (msg.status === "compacting") {
          if (loader) loader.setMessage("Compacting context...");
        }
        tui.requestRender();
        break;
      }

      case "cli_disconnected": {
        const notice = new Text(chalk.red("CLI disconnected"), 1, 0);
        insertBeforeEditor(notice);
        tui.requestRender();
        break;
      }

      case "cli_connected": {
        const notice = new Text(chalk.green("CLI connected"), 1, 0);
        insertBeforeEditor(notice);
        tui.requestRender();
        break;
      }

      case "message_history": {
        // Replay history
        for (const histMsg of msg.messages) {
          handleMessage(histMsg);
        }
        break;
      }

      case "event_replay": {
        for (const { msg: replayMsg } of msg.events) {
          handleMessage(replayMsg);
        }
        break;
      }

      case "error": {
        const errText = new Text(chalk.red(`Error: ${msg.message}`), 1, 0);
        insertBeforeEditor(errText);
        tui.requestRender();
        break;
      }
    }
  }

  // Set up Companion WebSocket client
  const client = new CompanionClient({
    host,
    sessionId,
    onMessage: handleMessage,
    onStatusChange: (status) => {
      statusBar.connectionStatus = status;
      tui.requestRender();
    },
  });

  // Wire up editor submit
  editor.onSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (statusBar.isRunning) return;

    // Send to Companion
    client.sendUserMessage(trimmed);

    // Show user message in TUI
    const userMd = new Markdown(
      chalk.blue("You: ") + trimmed,
      1,
      0,
      markdownTheme,
    );
    insertBeforeEditor(userMd);

    // Show loader
    statusBar.isRunning = true;
    editor.disableSubmit = true;
    loader = new Loader(
      tui,
      (s) => chalk.cyan(s),
      (s) => chalk.dim(s),
      "Thinking...",
    );
    insertBeforeEditor(loader);
    loader.start();
    tui.requestRender();
  };

  // Global keybindings
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      if (statusBar.isRunning) {
        client.interrupt();
        return { consume: true };
      }
      client.dispose();
      tui.stop();
      process.exit(0);
    }
    return undefined;
  });

  // Build UI tree
  const header = new Text(
    chalk.bold("ccpi") +
      chalk.dim(` — session ${sessionId.slice(0, 8)}`),
    1,
    0,
  );
  tui.addChild(statusBar);
  tui.addChild(header);
  tui.addChild(new Spacer(1));
  tui.addChild(editor);
  tui.setFocus(editor);

  // Connect and start
  client.connect();
  tui.start();
}

main().catch((err) => {
  console.error(chalk.red(err.message));
  process.exit(1);
});
