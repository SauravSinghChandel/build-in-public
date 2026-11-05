import path from "node:path";
import type { AgentEvent } from "./index.js";

const base = (file: unknown) =>
  typeof file === "string" && file ? path.basename(file) : "";
const short = (text: string, max = 48) =>
  text.length > max ? text.slice(0, max - 1) + "…" : text;
const READERS = /^(?:cat|sed|head|tail|nl|less|bat|wc|jq)\b/;
const SEARCHERS = /^(?:rg|grep|find|fd|ls|tree)\b/;

/** A last-path-component guess for a shell command's file argument. */
function fileArg(command: string) {
  const files = command.match(/[\w@./-]+\.[A-Za-z0-9]{1,6}\b/g);
  return files ? base(files.at(-1)) : "";
}
function describeCommand(raw: unknown) {
  const command = (Array.isArray(raw) ? raw.join(" ") : String(raw || ""))
    .replace(/^(?:\/bin\/)?(?:ba|z)?sh\s+-l?c\s+/, "")
    .replace(/^["']|["']$/g, "")
    .trim();
  if (!command) return "Running a command…";
  const file = fileArg(command);
  if (READERS.test(command) && file) return `Reading ${file}…`;
  if (SEARCHERS.test(command)) return "Searching files…";
  return `Running ${short(command)}…`;
}

/**
 * Turns a normalized agent event into a short, human activity line such as
 * "Reading styles.css…" or "Editing index.html…". Returns undefined when the event
 * carries nothing worth showing (results, plain text, session ids).
 */
export function activityLabel(event: AgentEvent): string | undefined {
  if (event.type !== "tool") return undefined;
  // Claude: tool_use blocks carry name + input; tool_result blocks carry only an id.
  if (event.name !== undefined && event.item === undefined) {
    const input = (event.input || {}) as Record<string, unknown>;
    const file = base(input.file_path ?? input.path ?? input.notebook_path);
    switch (event.name) {
      case "Read":
        return file ? `Reading ${file}…` : "Reading files…";
      case "Edit":
      case "MultiEdit":
      case "NotebookEdit":
        return file ? `Editing ${file}…` : "Editing files…";
      case "Write":
        return file ? `Writing ${file}…` : "Writing files…";
      case "Glob":
      case "Grep":
      case "LS":
        return input.pattern
          ? `Searching for ${short(String(input.pattern), 32)}…`
          : "Searching files…";
      case "Bash":
        return describeCommand(input.command);
      case "WebFetch":
      case "WebSearch":
        return "Searching the web…";
      case "TodoWrite":
        return "Planning…";
      case "StructuredOutput":
        return "Writing the result…";
      case null:
      case undefined:
        return undefined;
      default:
        return `Using ${event.name}…`;
    }
  }
  // Codex: item.started / item.completed events with typed items.
  const item = event.item as Record<string, any> | undefined;
  if (!item) return undefined;
  if (item.type === "command_execution" && event.phase === "item.started")
    return describeCommand(item.command);
  if (item.type === "file_change") {
    const files = (item.changes || []).map((c: { path?: string }) =>
      base(c.path),
    );
    return files.length
      ? `Editing ${files.slice(0, 2).join(", ")}${files.length > 2 ? ` and ${files.length - 2} more` : ""}…`
      : "Editing files…";
  }
  if (item.type === "mcp_tool_call" && event.phase === "item.started")
    return `Using ${item.tool || "a tool"}…`;
  if (item.type === "web_search") return "Searching the web…";
  if (item.type === "todo_list") return "Planning…";
  return undefined;
}
