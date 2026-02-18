#!/usr/bin/env bun
// Standalone NDJSON server that speaks Claude Code's --sdk-url protocol.
// Runs a TUI in-process and optionally serves a web UI.
// This is the "Approach E" PoC: TUI-first, no Companion dependency.

import chalk from "chalk";
import {
  TUI,
  ProcessTerminal,
  Editor,
  Markdown,
  Text,
  Spacer,
  Loader,
  matchesKey,
  type Component,
} from "@mariozechner/pi-tui";
import type { ContentBlock } from "./types.ts";

// -- NDJSON Protocol Types (Claude Code --sdk-url wire format) ---------------

interface CLISystemInit {
  type: "system";
  subtype: "init";
  session_id: string;
  tools?: string[];
  model?: string;
  mcp_servers?: Array<{ name: string; status: string }>;
}

interface CLIAssistant {
  type: "assistant";
  message: {
    id: string;
    role: "assistant";
    model: string;
    content: ContentBlock[];
    stop_reason: string | null;
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  parent_tool_use_id: string | null;
}

interface CLIUser {
  type: "user";
  message: {
    role: "user";
    content: string | ContentBlock[];
  };
  parent_tool_use_id: string | null;
}

interface CLIResult {
  type: "result";
  subtype: string;
  is_error: boolean;
  result?: string;
  errors?: string[];
  duration_ms: number;
  total_cost_usd: number;
  num_turns: number;
  session_id: string;
}

interface CLIControlRequest {
  type: "control_request";
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
    description?: string;
    tool_use_id: string;
  };
}

interface CLIStreamEvent {
  type: "stream_event";
  event: {
    type: string;
    index?: number;
    content_block?: ContentBlock;
    delta?: {
      type: string;
      text?: string;
      thinking?: string;
      partial_json?: string;
    };
  };
  parent_tool_use_id: string | null;
}

interface CLIKeepAlive {
  type: "keep_alive";
}

interface CLIToolProgress {
  type: "tool_progress";
  tool_use_id: string;
  tool_name: string;
  elapsed_time_seconds: number;
}

type CLIMessage =
  | CLISystemInit
  | CLIAssistant
  | CLIUser
  | CLIResult
  | CLIControlRequest
  | CLIStreamEvent
  | CLIKeepAlive
  | CLIToolProgress;

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

// -- Permission Banner (same as tui.ts) --------------------------------------

class PermissionBanner implements Component {
  focused = false;
  private onRespond: (behavior: "allow" | "deny") => void;

  constructor(
    private toolName: string,
    private input: Record<string, unknown>,
    onRespond: (behavior: "allow" | "deny") => void,
  ) {
    this.onRespond = onRespond;
  }

  invalidate(): void {}

  render(_width: number): string[] {
    let inputStr: string;
    if (this.toolName === "Bash" && typeof this.input.command === "string") {
      inputStr = `$ ${this.input.command}`;
    } else if (typeof this.input.file_path === "string") {
      inputStr = this.input.file_path;
    } else {
      inputStr = JSON.stringify(this.input, null, 2);
    }

    const lines = [
      "",
      chalk.bgYellow.black(` PERMISSION REQUEST `),
      chalk.yellow(`Tool: ${this.toolName}`),
    ];
    for (const line of inputStr.split("\n").slice(0, 10)) {
      lines.push(chalk.dim(`  ${line}`));
    }
    lines.push("");
    lines.push(
      `  ${chalk.green("[y] Allow")}  ${chalk.red("[n] Deny")}`,
    );
    lines.push("");
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "y") || matchesKey(data, "enter")) {
      this.onRespond("allow");
    } else if (matchesKey(data, "n") || matchesKey(data, "escape")) {
      this.onRespond("deny");
    }
  }
}

// -- Main App ----------------------------------------------------------------

async function main() {
  const port = parseInt(process.env.PORT ?? "3457", 10);
  const claudeBinary = process.env.CLAUDE_BINARY ?? "claude";

  // State
  let cliWs: import("bun").ServerWebSocket<unknown> | null = null;
  let browserWs: import("bun").ServerWebSocket<unknown> | null = null;
  let sessionId: string | null = null;
  let isRunning = false;

  // TUI setup
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const editor = new Editor(tui, editorTheme);

  let streamingText = "";
  let streamingMd: Markdown | null = null;
  let loader: Loader | null = null;
  let permissionBanner: PermissionBanner | null = null;

  function insertBeforeEditor(component: Component): void {
    const idx = tui.children.indexOf(editor);
    if (idx >= 0) {
      tui.children.splice(idx, 0, component);
    } else {
      tui.addChild(component);
    }
  }

  function removeLoader(): void {
    if (loader) {
      tui.removeChild(loader);
      loader.stop();
      loader = null;
    }
  }

  function ensureStreamingMd(): Markdown {
    if (!streamingMd) {
      removeLoader();
      streamingMd = new Markdown("", 1, 0, markdownTheme);
      insertBeforeEditor(streamingMd);
    }
    return streamingMd;
  }

  function finalizeStream(): void {
    streamingText = "";
    streamingMd = null;
  }

  // Send NDJSON message to CLI
  function sendToCli(msg: Record<string, unknown>): void {
    if (cliWs?.readyState === 1) {
      cliWs.send(JSON.stringify(msg) + "\n");
    }
  }

  // Broadcast to browser viewers
  function sendToBrowser(msg: Record<string, unknown>): void {
    if (browserWs?.readyState === 1) {
      browserWs.send(JSON.stringify(msg));
    }
  }

  // Handle NDJSON messages from Claude Code CLI
  function handleCliMessage(raw: string): void {
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: CLIMessage;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }

      // Forward raw to browser viewers
      sendToBrowser({ type: "cli_message", data: msg });

      switch (msg.type) {
        case "system": {
          if (msg.subtype === "init") {
            sessionId = msg.session_id;
            const info = new Text(
              chalk.dim(
                `Session: ${msg.session_id.slice(0, 8)} | Model: ${msg.model ?? "unknown"}`,
              ),
              1,
              0,
            );
            insertBeforeEditor(info);
            insertBeforeEditor(new Spacer(1));
            tui.requestRender();
          }
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
          if (
            event.type === "content_block_delta" &&
            event.delta?.type === "text_delta" &&
            event.delta.text
          ) {
            const md = ensureStreamingMd();
            streamingText += event.delta.text;
            md.setText(streamingText);
            tui.requestRender();
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
          isRunning = false;
          editor.disableSubmit = false;

          if (msg.is_error && msg.errors?.length) {
            const errText = new Text(
              chalk.red(`Error: ${msg.errors.join(", ")}`),
              1,
              0,
            );
            insertBeforeEditor(errText);
          }
          insertBeforeEditor(new Spacer(1));

          const costInfo = new Text(
            chalk.dim(
              `Cost: $${msg.total_cost_usd.toFixed(4)} | Turns: ${msg.num_turns} | Duration: ${(msg.duration_ms / 1000).toFixed(1)}s`,
            ),
            1,
            0,
          );
          insertBeforeEditor(costInfo);
          tui.requestRender();
          break;
        }

        case "control_request": {
          if (msg.request.subtype !== "can_use_tool") break;
          removeLoader();

          permissionBanner = new PermissionBanner(
            msg.request.tool_name,
            msg.request.input,
            (behavior) => {
              sendToCli({
                type: "control_response",
                response: {
                  subtype: "success",
                  request_id: msg.request_id,
                  response: { behavior },
                },
              });
              if (permissionBanner) {
                tui.removeChild(permissionBanner);
                permissionBanner = null;
              }
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

        case "tool_progress": {
          if (loader) {
            loader.setMessage(
              `Running ${msg.tool_name}... (${msg.elapsed_time_seconds.toFixed(0)}s)`,
            );
          }
          break;
        }

        case "keep_alive":
          break;
      }
    }
  }

  function extractText(blocks: ContentBlock[]): string {
    const parts: string[] = [];
    for (const block of blocks) {
      if (block.type === "text") {
        parts.push(block.text);
      } else if (block.type === "tool_use") {
        let inputStr: string;
        if (block.name === "Bash" && typeof block.input.command === "string") {
          inputStr = `$ ${block.input.command}`;
        } else {
          inputStr = JSON.stringify(block.input).slice(0, 100);
        }
        parts.push(`\n${chalk.dim(`⚡ ${block.name}`)} ${chalk.dim(inputStr)}\n`);
      } else if (block.type === "thinking") {
        parts.push(chalk.dim.italic(`💭 ${block.thinking}`));
      }
    }
    return parts.join("");
  }

  // Start WebSocket server for both CLI and browser connections
  const server = Bun.serve<{ role: string }>({
    port,
    fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (req.headers.get("upgrade") === "websocket") {
        if (url.pathname.startsWith("/ws/cli")) {
          return server.upgrade(req, { data: { role: "cli" } })
            ? undefined
            : new Response("Upgrade failed", { status: 500 });
        }
        if (url.pathname.startsWith("/ws/browser")) {
          return server.upgrade(req, { data: { role: "browser" } })
            ? undefined
            : new Response("Upgrade failed", { status: 500 });
        }
      }

      // Health check
      if (url.pathname === "/health") {
        return new Response(
          JSON.stringify({
            status: "ok",
            cli_connected: cliWs !== null,
            session_id: sessionId,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("ccpi ndjson-server", { status: 200 });
    },
    websocket: {
      open(ws) {
        const role = (ws.data as { role: string }).role;
        if (role === "cli") {
          cliWs = ws;
          const notice = new Text(chalk.green("Claude Code connected"), 1, 0);
          insertBeforeEditor(notice);
          tui.requestRender();
        } else {
          browserWs = ws;
        }
      },
      message(ws, data) {
        const role = (ws.data as { role: string }).role;
        if (role === "cli") {
          handleCliMessage(data.toString());
        } else {
          // Browser message -- forward user_message to CLI
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "user_message") {
              sendToCli({
                type: "user",
                message: { role: "user", content: msg.content },
                parent_tool_use_id: null,
                session_id: sessionId,
              });
            }
          } catch {
            // ignore
          }
        }
      },
      close(ws) {
        const role = (ws.data as { role: string }).role;
        if (role === "cli") {
          cliWs = null;
          const notice = new Text(chalk.red("Claude Code disconnected"), 1, 0);
          insertBeforeEditor(notice);
          tui.requestRender();
        } else {
          browserWs = null;
        }
      },
    },
  });

  // Wire up editor
  editor.onSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isRunning) return;

    sendToCli({
      type: "user",
      message: { role: "user", content: trimmed },
      parent_tool_use_id: null,
      session_id: sessionId,
    });

    const userMd = new Markdown(
      chalk.blue("You: ") + trimmed,
      1,
      0,
      markdownTheme,
    );
    insertBeforeEditor(userMd);

    isRunning = true;
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
      if (isRunning) {
        sendToCli({
          type: "control_request",
          request_id: crypto.randomUUID(),
          request: { subtype: "interrupt" },
        });
        return { consume: true };
      }
      tui.stop();
      server.stop();
      process.exit(0);
    }
    return undefined;
  });

  // Build UI
  const header = new Text(
    chalk.bold("ccpi") +
      chalk.dim(` — standalone server on :${port}`),
    1,
    0,
  );
  tui.addChild(header);
  tui.addChild(new Spacer(1));
  tui.addChild(editor);
  tui.setFocus(editor);

  console.log(
    chalk.dim(
      `WebSocket server listening on ws://localhost:${port}/ws/cli/{id}`,
    ),
  );
  console.log(
    chalk.dim(
      `Launch Claude Code with: claude -p --output-format stream-json --sdk-url ws://localhost:${port}/ws/cli/main`,
    ),
  );
  console.log("");

  // Spawn Claude Code CLI
  const cliProc = Bun.spawn(
    [
      claudeBinary,
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--sdk-url",
      `ws://localhost:${port}/ws/cli/main`,
      "--verbose",
    ],
    {
      env: {
        ...process.env,
        // Ensure stream-json format
        CLAUDE_CODE_OUTPUT_FORMAT: "stream-json",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  // The CLI should connect via WebSocket, not stdio.
  // But we watch stderr for startup errors.
  const stderrReader = cliProc.stderr.getReader();
  (async () => {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await stderrReader.read();
      if (done) break;
      const text = decoder.decode(value);
      if (text.trim()) {
        const errNotice = new Text(chalk.red(text.trim()), 1, 0);
        insertBeforeEditor(errNotice);
        tui.requestRender();
      }
    }
  })();

  tui.start();
}

main().catch((err) => {
  console.error(chalk.red(err.message));
  process.exit(1);
});
