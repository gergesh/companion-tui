#!/usr/bin/env bun
// Approach C PoC: Use the official Claude Agent SDK (TypeScript)
// with a dual TUI + WebSocket bridge.
//
// The Agent SDK spawns Claude Code CLI as a subprocess and communicates
// via NDJSON over stdio. We wrap it in an event bus that broadcasts
// to both the in-process TUI and connected WebSocket clients.

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

// NOTE: This PoC requires @anthropic-ai/claude-agent-sdk to be installed.
// The SDK is a thin wrapper that spawns the `claude` CLI binary.
//
// Install with: bun add @anthropic-ai/claude-agent-sdk
//
// The SDK provides two interfaces:
//   1. query()         - One-shot stateless queries
//   2. ClaudeSDKClient - Stateful bidirectional sessions

// Type stubs for the SDK (to avoid hard dependency for now)
interface SDKMessage {
  type: string;
  [key: string]: unknown;
}

interface SDKClient {
  send(message: { type: string; content: string }): Promise<void>;
  receive(): AsyncGenerator<SDKMessage>;
  close(): Promise<void>;
}

// -- Event Bus ---------------------------------------------------------------

type EventHandler = (event: SDKMessage) => void;

class EventBus {
  private handlers = new Set<EventHandler>();

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: SDKMessage): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // don't let one handler crash others
      }
    }
  }
}

// -- WebSocket Server for Browser Clients ------------------------------------

function startBrowserServer(
  bus: EventBus,
  port: number,
  sendToSdk: (content: string) => void,
) {
  const clients = new Set<import("bun").ServerWebSocket<unknown>>();

  // Broadcast SDK events to all connected browsers
  bus.subscribe((event) => {
    const json = JSON.stringify(event);
    for (const ws of clients) {
      ws.send(json);
    }
  });

  return Bun.serve({
    port,
    fetch(req, server) {
      if (req.headers.get("upgrade") === "websocket") {
        return server.upgrade(req) ? undefined : new Response("Failed", { status: 500 });
      }
      return new Response("ccpi sdk-bridge browser endpoint", { status: 200 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
      },
      message(_ws, data) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "user_message" && typeof msg.content === "string") {
            sendToSdk(msg.content);
          }
        } catch {
          // ignore
        }
      },
      close(ws) {
        clients.delete(ws);
      },
    },
  });
}

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

// -- Main (illustrative structure) -------------------------------------------

async function main() {
  const port = parseInt(process.env.PORT ?? "3458", 10);
  const bus = new EventBus();

  console.log(chalk.bold("ccpi sdk-bridge"));
  console.log(chalk.dim("This PoC demonstrates the Agent SDK approach."));
  console.log(chalk.dim("Requires: bun add @anthropic-ai/claude-agent-sdk"));
  console.log("");

  // Dynamic import so this file doesn't crash without the SDK installed
  let ClaudeSDKClient: new (opts: Record<string, unknown>) => SDKClient;
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    ClaudeSDKClient = sdk.ClaudeSDKClient;
  } catch {
    console.log(chalk.yellow("SDK not installed. Showing architecture only."));
    console.log("");
    console.log(chalk.dim("Architecture:"));
    console.log(
      chalk.dim(`
  ┌─────────────────────────┐
  │  Claude Agent SDK       │
  │  (ClaudeSDKClient)      │
  │                         │
  │  Spawns claude CLI      │
  │  NDJSON over stdio      │
  └───────────┬─────────────┘
              │
         EventBus
              │
    ┌─────────┼──────────┐
    │         │          │
  ┌─▼──┐  ┌──▼───┐  ┌───▼───┐
  │TUI │  │WebUI │  │ API   │
  │    │  │(ws)  │  │(REST) │
  └────┘  └──────┘  └───────┘
`),
    );
    console.log(chalk.dim("To use this approach:"));
    console.log(chalk.dim("  1. bun add @anthropic-ai/claude-agent-sdk"));
    console.log(chalk.dim("  2. bun run src/sdk-bridge.ts"));
    return;
  }

  // Create SDK client
  const client = new ClaudeSDKClient({
    permissionMode: "default",
  });

  // Queue for user messages
  const messageQueue: string[] = [];
  let pendingSend: ((content: string) => void) | null = null;

  function sendToSdk(content: string): void {
    if (pendingSend) {
      pendingSend(content);
      pendingSend = null;
    } else {
      messageQueue.push(content);
    }
  }

  // Start browser WebSocket server
  const server = startBrowserServer(bus, port, sendToSdk);
  console.log(chalk.dim(`Browser WebSocket on ws://localhost:${port}`));

  // TUI setup
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const editor = new Editor(tui, editorTheme);
  let isRunning = false;
  let loader: Loader | null = null;

  function insertBeforeEditor(component: Component): void {
    const idx = tui.children.indexOf(editor);
    if (idx >= 0) {
      tui.children.splice(idx, 0, component);
    } else {
      tui.addChild(component);
    }
  }

  // Subscribe TUI to event bus
  bus.subscribe((event) => {
    if (event.type === "assistant") {
      if (loader) {
        tui.removeChild(loader);
        loader.stop();
        loader = null;
      }
      const content = event.message as {
        content: Array<{ type: string; text?: string }>;
      };
      const text = content.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text.trim()) {
        const md = new Markdown(text, 1, 0, markdownTheme);
        insertBeforeEditor(md);
        insertBeforeEditor(new Spacer(1));
        tui.requestRender();
      }
    } else if (event.type === "result") {
      isRunning = false;
      editor.disableSubmit = false;
      if (loader) {
        tui.removeChild(loader);
        loader.stop();
        loader = null;
      }
      tui.requestRender();
    }
  });

  editor.onSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isRunning) return;

    sendToSdk(trimmed);

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

  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      tui.stop();
      server.stop();
      process.exit(0);
    }
    return undefined;
  });

  const header = new Text(
    chalk.bold("ccpi") + chalk.dim(" — Agent SDK bridge"),
    1,
    0,
  );
  tui.addChild(header);
  tui.addChild(new Spacer(1));
  tui.addChild(editor);
  tui.setFocus(editor);
  tui.start();

  // SDK message loop
  // This would use ClaudeSDKClient.send() and receive() in a loop.
  // Simplified for PoC:
  async function sdkLoop() {
    while (true) {
      // Wait for a user message
      const content = await new Promise<string>((resolve) => {
        if (messageQueue.length > 0) {
          resolve(messageQueue.shift()!);
        } else {
          pendingSend = resolve;
        }
      });

      // Send to SDK and stream responses
      try {
        await client.send({ type: "user_message", content });
        for await (const msg of client.receive()) {
          bus.emit(msg);
          if (msg.type === "result") break;
        }
      } catch (err) {
        bus.emit({
          type: "error",
          message: String(err),
        });
      }
    }
  }

  sdkLoop();
}

main().catch((err) => {
  console.error(chalk.red(err.message));
  process.exit(1);
});
