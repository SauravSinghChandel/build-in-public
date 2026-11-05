export type ProviderId = "claude" | "codex";
export interface AgentState {
  sessionId?: string | null;
  structuredOutput?: unknown;
  completed?: boolean;
  costUsd?: number;
  lastText?: string;
  usage?: unknown;
}
export interface AgentEvent extends AgentState {
  type: "text" | "tool" | "progress" | "result" | "error";
  [key: string]: any;
}
export interface AgentRequest {
  task?: string;
  prompt: string;
  workspace: string;
  readDirs?: string[];
  writeDirs?: string[];
  outputSchema?: object;
  resumeSessionId?: string;
  budgetUsd?: number;
  signal?: AbortSignal;
  onRaw?: (kind: string, chunk: string) => void;
}
export interface AgentProvider {
  id: ProviderId;
  supportsResume: boolean;
  detect(): Promise<{ installed: boolean; version?: string; authed?: boolean }>;
  run(req: AgentRequest): AsyncIterable<AgentEvent>;
}
import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { binaryFor } from "../config.js";

// Shapes: code.claude.com/docs/en/agent-sdk/{streaming-output,structured-outputs}
// and github.com/openai/codex/blob/main/sdk/typescript/src/events.ts.
export function normalize(
  provider: ProviderId,
  e: any,
  state: AgentState,
): AgentEvent[] {
  const events: AgentEvent[] = [];
  if (provider === "claude") {
    if (e.session_id) state.sessionId = e.session_id;
    if (e.type === "stream_event" && e.event?.delta?.text)
      events.push({ type: "text", text: e.event.delta.text });
    if (e.type === "assistant")
      for (const b of e.message?.content ?? []) {
        if (b.type === "text") events.push({ type: "text", text: b.text });
        if (b.type === "tool_use")
          events.push({ type: "tool", name: b.name, id: b.id, input: b.input });
      }
    if (e.type === "user")
      for (const b of e.message?.content ?? []) {
        if (b.type === "tool_result")
          events.push({
            type: "tool",
            id: b.tool_use_id,
            output: b.content,
            isError: b.is_error,
          });
      }
    if (e.type === "result") {
      state.completed = !e.is_error && e.subtype === "success";
      state.structuredOutput = e.structured_output ?? null;
      state.costUsd = e.total_cost_usd;
      if (!state.completed)
        events.push({
          type: "error",
          message: (e.errors ?? [e.result ?? e.subtype]).join("\n"),
        });
    }
  } else {
    if (e.type === "thread.started") state.sessionId = e.thread_id;
    if (e.type?.startsWith("item.") && e.item) {
      const i = e.item;
      if (i.type === "agent_message" && e.type === "item.completed") {
        events.push({ type: "text", text: i.text });
        state.lastText = i.text;
        try {
          state.structuredOutput = JSON.parse(i.text);
        } catch {
          state.structuredOutput = null;
        }
      } else if (!["agent_message", "reasoning"].includes(i.type)) {
        events.push({
          type: "tool",
          phase: e.type,
          name: i.type,
          id: i.id,
          item: i,
        });
      }
    }
    if (e.type === "turn.completed") {
      state.completed = true;
      state.usage = e.usage;
    }
    if (e.type === "error" || e.type === "turn.failed") {
      state.completed = false;
      events.push({
        type: "error",
        message: e.message ?? e.error?.message ?? "Unknown CLI error",
      });
    }
  }
  if (state.sessionId)
    events.unshift({ type: "progress", sessionId: state.sessionId });
  return events;
}

export class JsonlParser {
  buffer = "";
  constructor(
    public provider: ProviderId,
    public state: AgentState = {},
  ) {}
  push(chunk: string, end = false): AgentEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = end ? "" : lines.pop()!;
    if (this.buffer.length > 2_000_000) {
      this.buffer = "";
      return [{ type: "error", message: "JSONL line exceeds 2 MB" }];
    }
    return lines
      .filter((x) => x.trim())
      .flatMap((line) => {
        try {
          return normalize(this.provider, JSON.parse(line), this.state);
        } catch (error) {
          return [
            {
              type: "error",
              message: `Invalid JSONL: ${(error as Error).message}`,
            },
          ];
        }
      });
  }
}

export function buildArgs({
  provider,
  prompt,
  workspace,
  readDirs = [],
  outputSchema,
  schemaFile,
  resumeSessionId,
  budgetUsd,
}: AgentRequest & { provider: ProviderId; schemaFile: string }) {
  if (provider === "claude")
    return [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      ...(outputSchema ? ["--json-schema", JSON.stringify(outputSchema)] : []),
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "Read,Grep,Glob",
      ...readDirs.flatMap((d) => ["--add-dir", d]),
      "--strict-mcp-config",
      "--setting-sources",
      "user",
      "--max-budget-usd",
      String(budgetUsd ?? 1),
      ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
      "--",
      prompt,
    ];
  if (provider !== "codex") throw new Error(`Unknown provider: ${provider}`);
  // Parent exec options precede resume; the resume subcommand lacks -s/-C/--add-dir.
  return [
    "exec",
    "--json",
    ...(outputSchema ? ["--output-schema", schemaFile] : []),
    "-s",
    "read-only",
    "-C",
    workspace,
    ...readDirs.flatMap((d) => ["--add-dir", d]),
    "--skip-git-repo-check",
    ...(resumeSessionId ? ["resume", resumeSessionId] : []),
    "--",
    prompt,
  ];
}

export function createHarness(spawnProcess = spawn) {
  return async function* runAgent(
    options: AgentRequest & { provider: ProviderId },
  ): AsyncGenerator<AgentEvent> {
    const { provider, workspace, outputSchema, signal, onRaw } = options;
    const state: AgentState = {
      sessionId: options.resumeSessionId ?? null,
      structuredOutput: null,
      completed: false,
    };
    const started = performance.now();
    if (signal?.aborted) {
      yield {
        type: "result",
        final: true,
        ...state,
        exitCode: null,
        cancelled: true,
        totalMs: 0,
        startupMs: null,
      };
      return;
    }
    const schemaFile = path.join(workspace, `.schema-${randomUUID()}.json`);
    let child: ReturnType<typeof spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined,
      killTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false,
      cancelled = false,
      firstMs: number | null = null;
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    const put = (e: AgentEvent) => {
      queue.push(e);
      wake?.();
    };
    let stderr = "";
    const kill = (sig: NodeJS.Signals) => {
      if (!child?.pid || closed) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {}
      }
    };
    const abort = () => {
      if (closed || cancelled) return;
      cancelled = true;
      kill("SIGINT");
      timer = setTimeout(() => {
        kill("SIGTERM");
        killTimer = setTimeout(() => kill("SIGKILL"), 2000);
      }, 2000);
    };
    try {
      if (outputSchema)
        await writeFile(schemaFile, JSON.stringify(outputSchema));
      const args = buildArgs({ ...options, schemaFile });
      child = spawnProcess(binaryFor(provider), args, {
        cwd: workspace,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: true,
      });
      const parser = new JsonlParser(provider, state);
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");
      child.stdout!.on("data", (chunk) => {
        firstMs ??= performance.now() - started;
        onRaw?.("stdout", chunk);
        parser.push(chunk).forEach(put);
      });
      child.stderr!.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-65536);
        onRaw?.("stderr", chunk);
      });
      child.on("error", (error) =>
        put({ type: "error", message: error.message }),
      );
      child.on("close", (exitCode, exitSignal) => {
        if (cancelled && child?.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
        closed = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        parser.push("", true).forEach(put);
        if (exitCode !== 0 && !cancelled)
          put({
            type: "error",
            message: stderr || `CLI exited ${exitCode ?? exitSignal}`,
          });
        if (!state.completed && !cancelled && exitCode === 0)
          put({
            type: "error",
            message: "CLI exited without successful result",
          });
        put({
          type: "result",
          final: true,
          ...state,
          exitCode,
          exitSignal,
          cancelled,
          stderr,
          startupMs: firstMs,
          totalMs: performance.now() - started,
        });
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      while (true) {
        if (!queue.length)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        wake = undefined;
        while (queue.length) {
          const event = queue.shift()!;
          yield event;
          if (event.final) return;
        }
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (!closed) kill("SIGKILL");
      await unlink(schemaFile).catch(() => {});
    }
  };
}
export const runAgent = createHarness();

export function provider(id: ProviderId): AgentProvider {
  return {
    id,
    supportsResume: true,
    async detect() {
      const { agents } = await import("../doctor.js");
      const a = (await agents()).find((a) => a.id === id)!;
      return {
        installed: a.installed,
        version: a.version,
        authed: a.auth === "unknown" ? undefined : a.auth === "signed in",
      };
    },
    run(req) {
      return runAgent({ ...req, provider: id });
    },
  };
}
export const claude = provider("claude");
export const codex = provider("codex");
