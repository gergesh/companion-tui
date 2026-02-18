#!/usr/bin/env bun
// companion-tui - Terminal client for Companion server
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
  CombinedAutocompleteProvider,
  matchesKey,
  type Component,
  type SelectItem,
  type SlashCommand,
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
  McpServerDetail,
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
  gitBranch: string | null = null;

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
      if (
        this.session.permissionMode &&
        this.session.permissionMode !== "default"
      ) {
        parts.push(chalk.magenta(this.session.permissionMode));
      }
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

    if (this.gitBranch) {
      parts.push(chalk.dim(`⎇ ${this.gitBranch}`));
    }

    if (this.isRunning) {
      parts.push(chalk.cyan("⟳ running"));
      parts.push(chalk.dim("ESC to interrupt"));
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
  console.log(`${chalk.bold("companion-tui")} — TUI client for Claude Code via Companion

${chalk.dim("Usage:")}
  companion-tui                Connect to a running session, or create one
  companion-tui -c             Resume the most recent session (relaunch if exited)
  companion-tui -r             Pick a session to resume interactively
  companion-tui -r <id>        Resume a specific session by ID (prefix match)

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

  // Set up slash command autocomplete
  const slashCommands: SlashCommand[] = [
    { name: "help", description: "Show help" },
    { name: "clear", description: "Clear conversation" },
    { name: "quit", description: "Exit companion-tui" },
    { name: "exit", description: "Exit companion-tui" },
    { name: "mcp", description: "MCP server status" },
    { name: "model", description: "Switch model" },
    { name: "mode", description: "Switch permission mode" },
    { name: "status", description: "Show session info" },
    { name: "compact", description: "Compact context" },
  ];
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(slashCommands),
  );

  // Detect git branch
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode === 0) {
      statusBar.gitBranch = proc.stdout.toString().trim();
    }
  } catch {
    // not a git repo or git not available
  }

  // Streaming state
  let streamingText = "";
  let streamingMd: Markdown | null = null;
  let loader: Loader | null = null;
  let permissionBanner: PermissionBanner | null = null;

  // Track whether the current run was triggered by us or by another client (web UI)
  let locallyTriggered = false;

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
        // Skip our own echoes; show messages from other clients
        if (msg.sender_client_id === client.clientId) break;
        // Show messages from other clients (web UI) or history replay
        const label = chalk.magenta("Web: ");
        const userMd = new Markdown(
          label + msg.content,
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
        locallyTriggered = false;
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
        const nowRunning = msg.status === "running";
        statusBar.isRunning = nowRunning;

        if (nowRunning && !locallyTriggered) {
          // Another client (web UI) triggered a run
          editor.disableSubmit = true;
          const notice = new Text(
            chalk.dim.italic("  [input from web UI]"),
            0,
            0,
          );
          insertBeforeEditor(notice);
          loader = new Loader(
            tui,
            (s) => chalk.cyan(s),
            (s) => chalk.dim(s),
            "Thinking...",
          );
          insertBeforeEditor(loader);
          loader.start();
        }

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

      case "session_name_update": {
        header.setText(
          chalk.bold("companion-tui") +
            chalk.dim(` — ${msg.name}`),
        );
        tui.requestRender();
        break;
      }

      case "mcp_status": {
        renderMcpStatus(msg.servers);
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

  // Build UI tree
  const header = new Text(
    chalk.bold("companion-tui") +
      chalk.dim(` — session ${sessionId.slice(0, 8)}`),
    1,
    0,
  );
  tui.addChild(statusBar);
  tui.addChild(header);
  tui.addChild(new Spacer(1));
  tui.addChild(editor);
  tui.setFocus(editor);

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

  // -- Local slash commands ----------------------------------------------------

  function handleSlashCommand(cmd: string): boolean {
    const parts = cmd.split(/\s+/);
    const name = parts[0]!.toLowerCase();
    const arg = parts.slice(1).join(" ").trim();

    if (name === "/quit" || name === "/exit") {
      cleanup();
      return true;
    }
    if (name === "/clear") {
      clearConversation();
      return true;
    }
    if (name === "/help") {
      showHelp();
      return true;
    }
    if (name === "/mcp") {
      showMcp();
      return true;
    }
    if (name === "/model") {
      showModelPicker(arg || null);
      return true;
    }
    if (name === "/mode") {
      showModePicker(arg || null);
      return true;
    }
    if (name === "/status") {
      showStatus();
      return true;
    }
    // Everything else (e.g. /compact) goes to the CLI as a user message
    return false;
  }

  function clearConversation(): void {
    // Remove everything between the header and the editor
    const keep = new Set<Component>([statusBar, header, editor]);
    const toRemove = tui.children.filter((c) => !keep.has(c));
    for (const c of toRemove) {
      if (c instanceof Loader) c.stop();
      tui.removeChild(c);
    }
    // Re-add spacer between header and editor
    insertBeforeEditor(new Spacer(1));
    tui.requestRender();
  }

  function showHelp(): void {
    const helpText = [
      chalk.bold("Commands:"),
      `  ${chalk.cyan("/help")}          Show this help`,
      `  ${chalk.cyan("/clear")}         Clear conversation display`,
      `  ${chalk.cyan("/quit")}          Exit companion-tui`,
      `  ${chalk.cyan("/compact")}       Compact conversation context`,
      `  ${chalk.cyan("/mcp")}           Show MCP server status`,
      `  ${chalk.cyan("/model [name]")}  Switch model (picker if no arg)`,
      `  ${chalk.cyan("/mode [name]")}   Switch permission mode (picker if no arg)`,
      `  ${chalk.cyan("/status")}        Show session info`,
      "",
      chalk.bold("Keys:"),
      `  ${chalk.cyan("Esc")}            Interrupt current operation`,
      `  ${chalk.cyan("Ctrl+C")}         Interrupt, or exit if idle (2x to force)`,
      `  ${chalk.cyan("Enter")}          Send message`,
      "",
      chalk.dim("Other slash commands are forwarded to the Claude Code CLI."),
    ].join("\n");
    const helpMd = new Text(helpText, 1, 0);
    insertBeforeEditor(helpMd);
    insertBeforeEditor(new Spacer(1));
    tui.requestRender();
  }

  // -- /mcp command -----------------------------------------------------------

  // Tracks the last MCP status response for interactive toggle/reconnect
  let lastMcpServers: McpServerDetail[] = [];

  function showMcp(): void {
    client.mcpGetStatus();
    const notice = new Text(chalk.dim("Fetching MCP server status..."), 1, 0);
    insertBeforeEditor(notice);
    tui.requestRender();
  }

  function renderMcpStatus(servers: McpServerDetail[]): void {
    lastMcpServers = servers;
    if (servers.length === 0) {
      const notice = new Text(chalk.dim("No MCP servers configured."), 1, 0);
      insertBeforeEditor(notice);
      insertBeforeEditor(new Spacer(1));
      tui.requestRender();
      return;
    }

    const lines: string[] = [chalk.bold("MCP Servers:")];
    for (let i = 0; i < servers.length; i++) {
      const s = servers[i]!;
      const dot =
        s.status === "connected"
          ? chalk.green("●")
          : s.status === "connecting"
            ? chalk.yellow("●")
            : s.status === "disabled"
              ? chalk.dim("○")
              : chalk.red("●");
      const toolCount = s.tools?.length ?? 0;
      const toolsLabel = toolCount > 0 ? chalk.dim(` (${toolCount} tools)`) : "";
      lines.push(
        `  ${chalk.dim(`${i + 1}.`)} ${dot} ${chalk.bold(s.name)} ${chalk.dim(s.config.type)}${toolsLabel}`,
      );
      if (s.error) {
        lines.push(`     ${chalk.red(s.error)}`);
      }
    }
    lines.push("");
    lines.push(
      chalk.dim(
        "  Type number + t to toggle, number + r to reconnect (e.g. 1t, 2r)",
      ),
    );

    const mcpText = new Text(lines.join("\n"), 1, 0);
    insertBeforeEditor(mcpText);
    insertBeforeEditor(new Spacer(1));
    tui.requestRender();
  }

  // -- /model command --------------------------------------------------------

  function showModelPicker(directArg: string | null): void {
    if (directArg) {
      client.setModel(directArg);
      const notice = new Text(
        chalk.dim(`Switching model to ${chalk.bold(directArg)}...`),
        1,
        0,
      );
      insertBeforeEditor(notice);
      insertBeforeEditor(new Spacer(1));
      tui.requestRender();
      return;
    }

    const items: SelectItem[] = [
      {
        label: "claude-sonnet-4-6",
        value: "claude-sonnet-4-6",
        description: "Fast, balanced",
      },
      {
        label: "claude-opus-4-6",
        value: "claude-opus-4-6",
        description: "Most capable",
      },
      {
        label: "claude-haiku-4-5",
        value: "claude-haiku-4-5",
        description: "Quick, lightweight",
      },
    ];

    const list = new SelectList(items, items.length, selectListTheme);
    insertBeforeEditor(list);
    tui.setFocus(list);

    list.onSelect = (item: SelectItem) => {
      tui.removeChild(list);
      tui.setFocus(editor);
      client.setModel(item.value);
      const notice = new Text(
        chalk.dim(`Switching model to ${chalk.bold(item.value)}...`),
        1,
        0,
      );
      insertBeforeEditor(notice);
      insertBeforeEditor(new Spacer(1));
      tui.requestRender();
    };

    list.onCancel = () => {
      tui.removeChild(list);
      tui.setFocus(editor);
      tui.requestRender();
    };

    tui.requestRender();
  }

  // -- /mode command ---------------------------------------------------------

  function showModePicker(directArg: string | null): void {
    if (directArg) {
      client.setPermissionMode(directArg);
      const notice = new Text(
        chalk.dim(`Switching permission mode to ${chalk.bold(directArg)}...`),
        1,
        0,
      );
      insertBeforeEditor(notice);
      insertBeforeEditor(new Spacer(1));
      tui.requestRender();
      return;
    }

    const items: SelectItem[] = [
      {
        label: "default",
        value: "default",
        description: "Ask for permissions",
      },
      {
        label: "plan",
        value: "plan",
        description: "Read-only, no writes",
      },
      {
        label: "bypassPermissions",
        value: "bypassPermissions",
        description: "Skip all permission checks",
      },
    ];

    const list = new SelectList(items, items.length, selectListTheme);
    insertBeforeEditor(list);
    tui.setFocus(list);

    list.onSelect = (item: SelectItem) => {
      tui.removeChild(list);
      tui.setFocus(editor);
      client.setPermissionMode(item.value);
      const notice = new Text(
        chalk.dim(`Switching mode to ${chalk.bold(item.value)}...`),
        1,
        0,
      );
      insertBeforeEditor(notice);
      insertBeforeEditor(new Spacer(1));
      tui.requestRender();
    };

    list.onCancel = () => {
      tui.removeChild(list);
      tui.setFocus(editor);
      tui.requestRender();
    };

    tui.requestRender();
  }

  // -- /status command -------------------------------------------------------

  function showStatus(): void {
    const s = statusBar.session;
    if (!s) {
      const notice = new Text(
        chalk.dim("No session info available yet."),
        1,
        0,
      );
      insertBeforeEditor(notice);
      insertBeforeEditor(new Spacer(1));
      tui.requestRender();
      return;
    }

    const lines: string[] = [chalk.bold("Session Status:")];
    lines.push(`  Model:       ${chalk.cyan(s.model)}`);
    lines.push(`  Mode:        ${chalk.magenta(s.permissionMode)}`);
    lines.push(`  Cost:        ${chalk.yellow(`$${s.total_cost_usd.toFixed(4)}`)}`);
    lines.push(`  Context:     ${s.context_used_percent}%`);
    lines.push(`  Turns:       ${s.num_turns}`);
    lines.push(`  CWD:         ${chalk.dim(s.cwd)}`);
    if (statusBar.gitBranch) {
      lines.push(`  Git branch:  ${chalk.dim(statusBar.gitBranch)}`);
    }
    if (s.mcp_servers.length > 0) {
      lines.push(`  MCP servers: ${s.mcp_servers.length}`);
    }
    lines.push(`  Version:     ${chalk.dim(s.claude_code_version)}`);

    const statusText = new Text(lines.join("\n"), 1, 0);
    insertBeforeEditor(statusText);
    insertBeforeEditor(new Spacer(1));
    tui.requestRender();
  }

  function cleanup(): void {
    client.dispose();
    tui.stop();
    process.exit(0);
  }

  // Wire up editor submit
  editor.onSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Handle local slash commands
    if (trimmed.startsWith("/") && handleSlashCommand(trimmed)) {
      return;
    }

    // Handle MCP toggle/reconnect (e.g. "1t", "2r")
    const mcpAction = trimmed.match(/^(\d+)([tr])$/i);
    if (mcpAction && lastMcpServers.length > 0) {
      const idx = parseInt(mcpAction[1]!, 10) - 1;
      const action = mcpAction[2]!.toLowerCase();
      const server = lastMcpServers[idx];
      if (server) {
        if (action === "t") {
          const nowEnabled = server.status !== "disabled";
          client.mcpToggle(server.name, !nowEnabled);
          const verb = nowEnabled ? "Disabling" : "Enabling";
          const notice = new Text(
            chalk.dim(`${verb} ${chalk.bold(server.name)}...`),
            1,
            0,
          );
          insertBeforeEditor(notice);
          // Refresh status after a short delay
          setTimeout(() => client.mcpGetStatus(), 500);
        } else {
          client.mcpReconnect(server.name);
          const notice = new Text(
            chalk.dim(`Reconnecting ${chalk.bold(server.name)}...`),
            1,
            0,
          );
          insertBeforeEditor(notice);
          setTimeout(() => client.mcpGetStatus(), 1000);
        }
        tui.requestRender();
        return;
      }
    }

    if (statusBar.isRunning) return;

    // Send to Companion
    locallyTriggered = true;
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
  let lastCtrlC = 0;

  tui.addInputListener((data) => {
    // ESC: interrupt if running
    if (matchesKey(data, "escape")) {
      if (statusBar.isRunning) {
        client.interrupt();
        return { consume: true };
      }
      return undefined; // let editor handle it (e.g. close autocomplete)
    }

    // Ctrl+C: interrupt if running, exit if idle, force exit on double-tap
    if (matchesKey(data, "ctrl+c")) {
      const now = Date.now();
      if (statusBar.isRunning) {
        // Double Ctrl+C within 500ms: force exit even while running
        if (now - lastCtrlC < 500) {
          cleanup();
        }
        lastCtrlC = now;
        client.interrupt();
        return { consume: true };
      }
      cleanup();
    }
    return undefined;
  });

  // Connect and start
  client.connect();
  tui.start();
}

main().catch((err) => {
  console.error(chalk.red(err.message));
  process.exit(1);
});
