# Agents

BIP doesn't call a model API itself. For every agent action it starts the Claude Code or Codex CLI that you installed and signed in to, in non-interactive mode, and reads its JSON event stream. You pick the agent next to each action; BIP remembers the last choice per task type and project.

The code is in `apps/server/src/agents/` (`index.ts` builds the arguments, runs the process and normalises events; `context.ts` builds the prompt context; `schema.ts` adapts output schemas; `activity.ts` turns tool events into progress lines).

## Which binary runs

| Agent | Environment variable | `config.json` key | Default |
|---|---|---|---|
| Claude Code | `BIP_CLAUDE_BIN` | `claudeBin` | `claude` on `PATH` |
| Codex | `BIP_CODEX_BIN` | `codexBin` | `codex` on `PATH` |

The environment variable wins over the config file. Tests point both at `tests/fixtures/agents/fake.mjs`.

## Exact invocation

Claude Code:

```
claude -p --output-format stream-json --verbose
  [--json-schema '<schema JSON>']
  --permission-mode dontAsk
  --allowedTools Read,Grep,Glob            # Read,Grep,Glob,Edit,Write for edit tasks
  [--add-dir <dir> ...]                    # only the repository, only for project summaries
  --strict-mcp-config --setting-sources user
  --max-budget-usd 1
  [--resume <session-id>]
  -- <prompt>
```

Codex:

```
codex exec --json
  [--output-schema <workspace>/.schema-<uuid>.json]
  -s read-only                             # workspace-write for edit tasks
  -C <workspace>
  [--add-dir <dir> ...]
  [-i <image>]                             # the contact sheet, for video edits
  --skip-git-repo-check
  [resume <session-id>]
  -- <prompt>
```

The flags were checked against Claude Code 2.1.318 and codex-cli 0.166.0. In both cases:

- The process is started with `spawn` and an argument array (no shell), stdin closed, and its own process group.
- The working directory is a fresh folder in BIP's data directory, `<data>/workspaces/<job-id>/` (for image and video edits, a `comp/` copy of the composition inside it). It is never inside a tracked repository; the image and video studios refuse to run an agent if the workspace resolves inside one.
- `--bare` is not used, because it ignores the subscription login.
- Cancel sends SIGINT to the process group, then SIGTERM after 2 s, then SIGKILL after another 2 s.
- The raw stdout of every run is saved to `<data>/logs/agents/<run-id>.jsonl`, and the run (provider, session id, working directory, exit code, and Claude's reported `total_cost_usd`) is recorded in `app.db` (`agent_runs`). Cost is not shown in the UI yet.

## Why the agents run outside your repositories

Your tracked repositories are untrusted input. A `claude -p` started with its working directory inside a repository loads that repository's project settings, so its hooks and `.mcp.json` servers run. BIP's M0 spike proved this with a control run (a canary hook and MCP server in a test repository both fired) and showed that the isolated pattern above blocks both, for Claude and for Codex.

So BIP never uses a repository as the working directory. Writing tasks get a prepared context bundle as text inside the prompt. Only the project summary task gives the agent the repository itself, through `--add-dir` with read-only tools (Claude) or the read-only sandbox (Codex). `--setting-sources user` and `--strict-mcp-config` keep Claude from loading project or local settings and any MCP servers not passed on the command line. Prompts tell the agent that repository text is data, not instructions. See [security.md](security.md).

## What each task sends

| Task | Gets | Can write |
|---|---|---|
| Story angles, post drafts, post edits | Context bundle (below) and the current draft text | Nothing |
| Project summary | Context bundle, plus read-only access to the repository | Nothing |
| Capture steps (image/video) | Your description and an element map of the page at the URL you entered | Nothing |
| Image alt text | A read-only copy of the image in the workspace | Nothing |
| Video captions | Context bundle and the measured event log of the recording | Nothing |
| Image and video edits | A copy of the composition in the workspace, read-only copies of its sources, and (video) the contact sheet | The composition copy only |

The context bundle (`buildContext` in `agents/context.ts`) contains: the project name and settings, `context.md` (first 8,000 characters), `auto-summary.md`, the first 80 lines of the README, your note, and for each selected commit its `git show --stat` and a diff capped at 120 lines per file. Lock files, `node_modules`, build output, `.env` files and binary diffs are skipped. Secret patterns (cloud keys, GitHub/Slack/Stripe tokens, private keys, JWTs, `.env` values) are replaced with `[REDACTED]` before the bundle is capped at 34,000 bytes. The lines of `private.md` are appended as a "never mention" list so the agent can avoid them; this means they are sent to the provider.

BIP's own instructions to the agents are in `agent-skills/` (`post-writer.md`, `image-composer.md`, `video-editor.md`).

## Structured output

Every task asks for JSON that matches a Zod schema. BIP converts it to JSON Schema and adapts it to what the CLIs accept (`agentSchema()` in `content.ts` and `agents/schema.ts`): it removes the `$schema` key, which Claude Code rejects, and makes optional fields required and nullable, which Codex's strict mode needs. Nulls are stripped again before the result is validated.

## Sign-in, API keys and usage

BIP never reads, stores, or passes on Claude or Codex credentials, and never shows a login screen for them. Sign in with the CLI itself:

- Claude Code: run `claude` once in a terminal and sign in, or set up an API key the way Claude Code documents.
- Codex: run `codex login`, or use an API key as Codex documents (for example `CODEX_API_KEY`).

The child process inherits BIP's environment, so key-based setups that work in your shell work in BIP too.

Settings → Agents and `run doctor` show each CLI's version. Codex sign-in is checked with `codex login status`. Claude Code has no equivalent non-interactive check, so its sign-in status shows as "unknown"; a failed sign-in shows up as an error on the first job.

Usage and cost:

- Calls made through `claude -p` while signed in with a Claude plan count against that plan's normal usage limits (per Anthropic's help article as of October 2026). Terms have changed several times; check Anthropic's current terms. With an API key, usage is billed to that key.
- Codex calls count against your ChatGPT plan or API key under OpenAI's terms.
- Each Claude run is capped at `--max-budget-usd 1`.

## Adding a provider

The provider interface is in `apps/server/src/agents/index.ts`:

```ts
export interface AgentProvider {
  id: ProviderId;
  supportsResume: boolean;
  detect(): Promise<{ installed: boolean; version?: string; authed?: boolean }>;
  run(req: AgentRequest): AsyncIterable<AgentEvent>;
}
```

`run` receives the prompt, workspace, optional `readDirs`, `writeDirs`, `images`, `outputSchema`, `resumeSessionId` and an `AbortSignal`, and yields normalised events: `text`, `tool`, `progress` (carrying `sessionId`), `error`, and a final `result` with `final: true`, `completed`, `structuredOutput`, `exitCode` and `cancelled`.

The two built-in providers share one process harness (`createHarness`): `buildArgs` produces the argument list and `normalize` maps each JSONL line to events. A new CLI provider usually needs a branch in each:

```ts
// agents/index.ts
export type ProviderId = "claude" | "codex" | "mycli";

// in buildArgs()
if (provider === "mycli")
  return [
    "run", "--json",
    "--cwd", workspace,
    ...(outputSchema ? ["--schema", schemaFile] : []),
    ...(writeDirs.length ? [] : ["--read-only"]),
    ...readDirs.flatMap((d) => ["--read", d]),
    ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
    "--", prompt,
  ];

// in normalize()
if (provider === "mycli") {
  if (e.session) state.sessionId = e.session;
  if (e.type === "message") events.push({ type: "text", text: e.text });
  if (e.type === "done") {
    state.completed = e.ok;
    state.structuredOutput = e.output ?? null;
    if (!e.ok) events.push({ type: "error", message: e.error });
  }
}

export const mycli = provider("mycli");
```

The provider id is also hard-coded in these places, which need the new value:

- `binaryFor()` in `apps/server/src/config.ts`, plus a config key and `BIP_*_BIN` variable.
- `agents()` in `apps/server/src/doctor.ts` (version and sign-in detection).
- The `z.enum(["claude", "codex"])` request validators in `content-routes.ts`, `image/routes.ts` and `video/routes.ts`, and `lastAgent` in `packages/shared/src/index.ts`.
- The agent picker in `apps/web/src/features/studio/jobs.tsx` and the `"claude" | "codex"` state types in the studio components.
- A fake mode in `tests/fixtures/agents/fake.mjs` and recorded JSONL fixtures, so tests never call the real CLI.

Keep the rules from this page: a fresh workspace as the working directory, read-only by default, no project-level configuration or plugins loaded, no credential handling, and a process group that can be cancelled.
