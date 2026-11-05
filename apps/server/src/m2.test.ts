import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildArgs,
  JsonlParser,
  runAgent,
  type AgentEvent,
} from "./agents/index.js";
import {
  buildContext,
  capDiff,
  redact,
  secretWarnings,
} from "./agents/context.js";
import { JobRunner, EventRing } from "./jobs/runner.js";
import { openDatabase } from "./db.js";
import { openProject } from "./bip/store.js";
import { git } from "./git.js";
import { createApp } from "./app.js";
import { advanceMarker } from "./content.js";
import { Draft, textLength, validateParts, publishUrl } from "@bip/shared";
let root: string;
const cleanup: (() => Promise<void> | void)[] = [];
const fake = path.resolve("tests/fixtures/agents/fake.mjs");
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "bip-m2-unit-"));
  vi.stubEnv("BIP_CLAUDE_BIN", fake);
  vi.stubEnv("BIP_CODEX_BIN", fake);
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
async function repo() {
  const dir = path.join(root, "repo");
  await fs.mkdir(dir);
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.name", "Author"]);
  await git(dir, ["config", "user.email", "author@example.com"]);
  return dir;
}
async function commit(dir: string, text: string) {
  await fs.writeFile(path.join(dir, "work.txt"), text);
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", text]);
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}
async function collect(
  provider: "claude" | "codex",
  opts: Record<string, any> = {},
) {
  const events: AgentEvent[] = [];
  for await (const event of runAgent({
    provider,
    prompt: "fixture",
    workspace: root,
    ...opts,
  }))
    events.push(event);
  return events;
}
async function waitUntil(fn: () => boolean) {
  await vi.waitFor(() => expect(fn()).toBe(true), {
    timeout: 5000,
    interval: 20,
  });
}
function service() {
  const app = createApp({ home: path.join(root, "app"), fsHome: root });
  cleanup.push(() => app.close());
  return app;
}
function request(
  app: ReturnType<typeof createApp>,
  url: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.app.request("http://127.0.0.1:4310/api" + url, {
    method,
    headers: {
      host: "127.0.0.1:4310",
      cookie: `bip_session=${app.token}`,
      "content-type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
describe("agent adapters", () => {
  it.each(["claude", "codex"] as const)(
    "snapshots isolated argv for %s, including resume",
    (provider) => {
      expect(
        buildArgs({
          provider,
          prompt: "untrusted text",
          workspace: "/fresh/workspace",
          readDirs: ["/tracked/repo"],
          outputSchema: { type: "object" },
          schemaFile: "/fresh/workspace/schema.json",
          resumeSessionId: "session-1",
        }),
      ).toMatchSnapshot();
    },
  );
  it.each(["claude", "codex"] as const)(
    "parses real reconstructed %s fixtures at arbitrary chunk boundaries",
    async (provider) => {
      const source = await fs.readFile(
        `tests/fixtures/agents/${provider}-draft.jsonl`,
        "utf8",
      );
      const parser = new JsonlParser(provider);
      const events = [];
      for (let i = 0; i < source.length; i += 17)
        events.push(...parser.push(source.slice(i, i + 17)));
      events.push(...parser.push("", true));
      expect(parser.state.completed).toBe(true);
      expect(Draft.safeParse(parser.state.structuredOutput).success).toBe(true);
      expect(parser.state.sessionId).toBeTruthy();
      expect(events.some((e) => e.type === "tool" || e.type === "text")).toBe(
        true,
      );
      if (provider === "claude")
        expect(parser.state.costUsd).toBeGreaterThan(0);
    },
  );
  it("escalates SIGINT to SIGTERM after two seconds for an uncooperative agent", async () => {
    vi.stubEnv("BIP_FAKE_MODE", "stubborn");
    const abort = new AbortController();
    const events: AgentEvent[] = [];
    const started = Date.now();
    for await (const e of runAgent({
      provider: "claude",
      prompt: "fixture",
      workspace: root,
      signal: abort.signal,
    })) {
      events.push(e);
      if (e.sessionId) setTimeout(() => abort.abort(), 100);
    }
    expect(events.at(-1)).toMatchObject({
      cancelled: true,
      exitSignal: "SIGTERM",
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
  });
  it("reports malformed streams", () =>
    expect(new JsonlParser("codex").push("bad\n")[0].type).toBe("error"));
  it.each(["claude", "codex"] as const)(
    "runs, cancels and resumes fake %s",
    async (provider) => {
      expect((await collect(provider)).at(-1)).toMatchObject({
        completed: true,
        exitCode: 0,
      });
      vi.stubEnv("BIP_FAKE_MODE", "slow");
      const abort = new AbortController();
      const events: AgentEvent[] = [];
      for await (const e of runAgent({
        provider,
        prompt: "fixture",
        workspace: root,
        signal: abort.signal,
      })) {
        events.push(e);
        if (e.sessionId) abort.abort();
      }
      expect(events.at(-1)?.cancelled).toBe(true);
      const session = events.find((e) => e.sessionId)?.sessionId;
      expect(session).toBeTruthy();
      expect(
        (await collect(provider, { resumeSessionId: session })).at(-1)
          ?.completed,
      ).toBe(true);
    },
  );
  it("distinguishes invalid schema and nonzero exits", async () => {
    vi.stubEnv("BIP_FAKE_MODE", "invalid");
    expect(
      Draft.safeParse((await collect("claude")).at(-1)?.structuredOutput)
        .success,
    ).toBe(false);
    vi.stubEnv("BIP_FAKE_MODE", "nonzero");
    const events = await collect("codex");
    expect(events.at(-1)?.exitCode).toBe(7);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});
describe("job runner", () => {
  it("limits concurrency to two, excludes resource overlap and preserves eligible FIFO", async () => {
    const db = openDatabase(root);
    cleanup.push(() => {
      db.close();
    });
    db.prepare(
      "INSERT INTO projects(id,path,root_commit,added_at) VALUES('p','/test','sha','now')",
    ).run();
    const started: string[] = [],
      release = new Map<string, () => void>();
    const runner = new JobRunner(db, async (job) => {
      started.push(job.payload.name);
      await new Promise<void>((resolve) =>
        release.set(job.payload.name, resolve),
      );
      return job.payload.name;
    });
    cleanup.push(() => runner.close());
    const a = runner.enqueue("test", "p", "same", { name: "a" });
    runner.enqueue("test", "p", "same", { name: "b" });
    runner.enqueue("test", "p", "other", { name: "c" });
    await waitUntil(() => started.length === 2);
    expect(started).toEqual(["a", "c"]);
    release.get("a")!();
    await waitUntil(() => started.includes("b"));
    expect(runner.get(a.id).status).toBe("succeeded");
    release.get("b")!();
    release.get("c")!();
    await waitUntil(() => runner.list().every((j) => j.status === "succeeded"));
  });
  it("marks running jobs interrupted on startup", () => {
    const db = openDatabase(root);
    cleanup.push(() => {
      db.close();
    });
    db.prepare(
      "INSERT INTO jobs(id,type,status,payload_json) VALUES('j','test','running','{}')",
    ).run();
    const runner = new JobRunner(db, async () => null);
    cleanup.push(() => runner.close());
    expect(runner.get("j").status).toBe("interrupted");
  });
  it("replays SSE by Last-Event-ID through cookie-auth endpoint", async () => {
    const app = service();
    app.content.jobs.events.publish("j", "running");
    app.content.jobs.events.publish("j", "text", { text: "partial" });
    const response = await request(app, "/events", "GET", undefined, {
      "Last-Event-ID": "1",
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes("connected")) {
      const chunk = await reader.read();
      text += new TextDecoder().decode(chunk.value);
    }
    expect(text).toContain("id: 2");
    expect(text).toContain("partial");
    expect(text).not.toContain("id: 1");
    await reader.cancel();
  });
  it("keeps a bounded event ring", () => {
    const ring = new EventRing(2);
    ring.publish("j", "queued");
    ring.publish("j", "running");
    ring.publish("j", "succeeded");
    expect(ring.since(1).map((e) => e.id)).toEqual([2, 3]);
  });
});
describe("content and safety", () => {
  it("applies URL length rule, limits, hashtags and host validation", () => {
    expect(textLength("a https://example.com/" + "x".repeat(300), "x")).toBe(
      25,
    );
    expect(validateParts(["x".repeat(281)], "x")[0]).toContain("Shorten");
    expect(validateParts(["#one #two"], "x")).toContain(
      "Use at most one hashtag",
    );
    expect(validateParts(["short"], "linkedin")[0]).toContain("Expand");
    expect(publishUrl("https://x.com/me/status/123", "x")).toBe(true);
    expect(publishUrl("https://linkedin.com/posts/1", "linkedin")).toBe(true);
    for (const url of [
      "https://x.com.evil.test/post",
      "javascript:alert(1)",
      "http://x.com/a",
      "https://evil@x.com/a",
    ])
      expect(publishUrl(url, "x")).toBe(false);
  });
  it("redacts planted token classes and private keys", () => {
    const secrets = [
      "AKIA" + "A".repeat(16),
      "AIza" + "b".repeat(35),
      "ghp_" + "a".repeat(30),
      "sk-proj-" + "b".repeat(30),
      "sk-ant-api03-" + "z".repeat(30),
      "xoxb-" + "a".repeat(20),
      "sk_live_" + "z".repeat(24),
      "eyJabc.abc.def",
      "API_KEY=pretend-secret",
      "KEY=pretend-secret",
      "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    ];
    for (const secret of secrets) {
      expect(redact(secret)).not.toContain(secret);
      expect(secretWarnings(secret)).toHaveLength(1);
    }
  });
  it("caps README, per-file diffs and bundle, excludes lockfiles, scans private notes", async () => {
    const dir = await repo();
    await fs.writeFile(
      path.join(dir, "README.md"),
      Array.from({ length: 100 }, (_, n) => `README_LINE_${n}`).join("\n"),
    );
    await fs.writeFile(path.join(dir, "package-lock.json"), "LOCKFILE_CANARY");
    await fs.writeFile(path.join(dir, "large.txt"), "x\n".repeat(300));
    const sha = await commit(dir, "Work");
    const s = await openProject(dir);
    cleanup.push(() => s.close());
    await s.writeContext({
      shareable: "API_KEY=planted-secret",
      private: "Never name Acme\nTOKEN=planted-token",
    });
    const bundle = await buildContext(s, [sha], "user note");
    expect(Buffer.byteLength(bundle)).toBeLessThan(40000);
    expect(bundle.split("Commit ")[0]).not.toContain("README_LINE_80");
    expect(bundle).not.toContain("LOCKFILE_CANARY");
    expect(bundle).not.toContain("planted-secret");
    expect(bundle).not.toContain("planted-token");
    expect(bundle).toContain("Never mention");
    expect(
      capDiff("diff --git a/a b/a\n" + "line\n".repeat(500)).split("\n").length,
    ).toBeLessThanOrEqual(120);
  });
  it("restores by append, invalidates approval, coalesces manual edits and preserves claims", async () => {
    const app = service(),
      dir = await repo();
    await commit(dir, "one");
    const [row] = await app.projects.track([dir]);
    const s = await app.projects.store(row.id);
    const story = await s.createStory({ title: "Test" }),
      post = await s.createPost(story.id, { platform: "x" });
    const first = await s.addRevision(story.id, post.id, {
      parts: ["original"],
      author: "agent",
      claims: ["Check claim"],
    });
    await s.updatePost(story.id, post.id, {
      approvedRevisionId: first.id,
      status: "approved",
    });
    await s.addRevision(story.id, post.id, {
      parts: ["manual"],
      author: "user",
      coalesce: true,
    });
    await s.addRevision(story.id, post.id, {
      parts: ["manual again"],
      author: "user",
      coalesce: true,
    });
    expect((await s.readRevisions(story.id, post.id)).revisions).toHaveLength(
      2,
    );
    expect(
      (await s.readPost(story.id, post.id)).approvedRevisionId,
    ).toBeUndefined();
    const response = await request(
      app,
      `/projects/${row.id}/stories/${story.id}/posts/${post.id}/restore`,
      "POST",
      { revisionId: first.id },
    );
    expect(response.status).toBe(200);
    const r = await response.json();
    expect(r).toMatchObject({
      parts: ["original"],
      author: "user",
      instruction: "Restored revision 1",
      claims: ["Check claim"],
    });
    expect((await s.readRevisions(story.id, post.id)).revisions).toHaveLength(
      3,
    );
  });
  it("advances markers forward, refuses rewind and divergent history", async () => {
    const dir = await repo(),
      a = await commit(dir, "one"),
      b = await commit(dir, "two");
    const s = await openProject(dir);
    cleanup.push(() => s.close());
    expect(await advanceMarker(s, a)).toBe(true);
    expect(await advanceMarker(s, b)).toBe(true);
    expect(await advanceMarker(s, a)).toBe(false);
    await git(dir, ["checkout", "-b", "other", a]);
    const c = await commit(dir, "other");
    expect(await advanceMarker(s, c)).toBe(false);
    expect(s.project.lastSharedCommit).toBe(b);
  });
  it("rejects secret approval, unchecked claims, stale revisions and unapproved publishing", async () => {
    const app = service(),
      dir = await repo();
    await commit(dir, "one");
    const [row] = await app.projects.track([dir]);
    const s = await app.projects.store(row.id);
    const story = await s.createStory({ title: "Test" }),
      post = await s.createPost(story.id, { platform: "x" });
    let r = await s.addRevision(story.id, post.id, {
      parts: ["API_KEY=secret-value"],
      author: "agent",
    });
    await expect(
      app.content.approve(row.id, story.id, post.id, r.id, [], false),
    ).rejects.toThrow("secrets");
    r = await s.addRevision(story.id, post.id, {
      parts: ["clean"],
      author: "agent",
      claims: ["Verify"],
    });
    await expect(
      app.content.approve(row.id, story.id, post.id, r.id, [], false),
    ).rejects.toThrow("claim");
    await expect(
      app.content.publish(
        row.id,
        story.id,
        post.id,
        "https://x.com/me/status/1",
      ),
    ).rejects.toThrow("Approve");
    await app.content.approve(row.id, story.id, post.id, r.id, [0], false);
    await s.addRevision(story.id, post.id, {
      parts: ["changed"],
      author: "user",
    });
    await expect(
      app.content.approve(row.id, story.id, post.id, r.id, [0], false),
    ).rejects.toThrow("changed");
  });
  it("runs drafts through jobs, saves raw logs and fails schema-invalid output", async () => {
    const app = service(),
      dir = await repo();
    const sha = await commit(dir, "one");
    const [row] = await app.projects.track([dir]);
    const s = await app.projects.store(row.id);
    const story = await s.createStory({
      title: "Test",
      selectedCommits: [sha],
    });
    const job = await app.content.task("post.draft", row.id, {
      storyId: story.id,
      provider: "claude",
    });
    await waitUntil(() =>
      ["succeeded", "failed"].includes(app.content.jobs.get(job.id).status),
    );
    expect(app.content.jobs.get(job.id).error).toBeNull();
    expect((await app.content.story(row.id, story.id)).posts).toHaveLength(2);
    const run = app.db
      .prepare("SELECT * FROM agent_runs WHERE job_id=?")
      .get(job.id) as any;
    expect(run.cost_usd).toBeGreaterThan(0);
    expect(await fs.readFile(run.log_path, "utf8")).toContain("session_id");
    vi.stubEnv("BIP_FAKE_MODE", "invalid");
    const invalid = await app.content.task("story.angles", row.id, {
      provider: "codex",
      commits: [sha],
    });
    await waitUntil(() => app.content.jobs.get(invalid.id).status === "failed");
    expect(app.content.jobs.get(invalid.id).error).toContain("angles");
  });
  it("summary records the inspected HEAD and reports staleness after a new commit", async () => {
    const app = service(),
      dir = await repo(),
      head = await commit(dir, "first");
    const [row] = await app.projects.track([dir]);
    const job = await app.content.task("project.summary", row.id, {
      provider: "codex",
    });
    await waitUntil(() =>
      ["succeeded", "failed"].includes(app.content.jobs.get(job.id).status),
    );
    expect(app.content.jobs.get(job.id).error).toBeNull();
    let response = await request(app, `/projects/${row.id}/summary`);
    expect(await response.json()).toMatchObject({
      stale: false,
      text: expect.stringContaining(`head: ${head}`),
    });
    await commit(dir, "second");
    response = await request(app, `/projects/${row.id}/summary`);
    expect(await response.json()).toMatchObject({ stale: true });
  });
  it("independent rewrites, adaptation and follow-ups append revisions without resuming other jobs", async () => {
    const app = service(),
      dir = await repo();
    await commit(dir, "first");
    const [row] = await app.projects.track([dir]);
    const s = await app.projects.store(row.id),
      story = await s.createStory({ title: "Edit" });
    const x = await s.createPost(story.id, { platform: "x" }),
      li = await s.createPost(story.id, { platform: "linkedin" });
    await s.addRevision(story.id, x.id, {
      parts: ["Original"],
      author: "user",
    });
    await s.addRevision(story.id, li.id, {
      parts: ["Source LinkedIn"],
      author: "user",
    });
    for (const extra of [
      { instruction: "Tone: Technical" },
      { instruction: "Adapt from linkedin", sourcePostId: li.id },
      { instruction: "Follow-up", followUp: true },
    ]) {
      const j = await app.content.task("post.edit", row.id, {
        provider: "codex",
        storyId: story.id,
        postId: x.id,
        ...extra,
      });
      await waitUntil(() =>
        ["succeeded", "failed"].includes(app.content.jobs.get(j.id).status),
      );
      expect(app.content.jobs.get(j.id).error).toBeNull();
    }
    const view = await app.content.story(row.id, story.id);
    expect(view.posts.find((v) => v.post.id === x.id)?.revisions).toHaveLength(
      3,
    );
    expect(
      view.posts.find((v) => v.post.replyToPostId === x.id)?.post.kind,
    ).toBe("follow_up");
    const runs = app.db
      .prepare("SELECT log_path FROM agent_runs ORDER BY rowid")
      .all() as { log_path: string }[];
    for (const run of runs)
      expect(await fs.readFile(run.log_path, "utf8")).toContain(
        '"type":"thread.started"',
      );
    expect((await s.project).settings.lastAgent?.["post.edit"]).toBe("codex");
  });
  it("coalescing keeps every disk snapshot while exposing one logical manual revision", async () => {
    const dir = await repo();
    await commit(dir, "first");
    const s = await openProject(dir);
    cleanup.push(() => s.close());
    const story = await s.createStory({ title: "Manual" }),
      post = await s.createPost(story.id, { platform: "x" });
    const first = await s.addRevision(story.id, post.id, {
      parts: ["one"],
      author: "user",
      coalesce: true,
    });
    const second = await s.addRevision(story.id, post.id, {
      parts: ["two"],
      author: "user",
      coalesce: true,
    });
    const third = await s.addRevision(story.id, post.id, {
      parts: ["three"],
      author: "user",
      coalesce: true,
    });
    expect(second.id).not.toBe(first.id);
    expect(third.id).not.toBe(second.id);
    expect((await s.readRevisions(story.id, post.id)).revisions).toMatchObject([
      { id: third.id, parts: ["three"] },
    ]);
    const disk = await fs.readFile(
      path.join(
        s.root,
        "stories",
        story.id,
        "posts",
        post.id,
        "revisions.jsonl",
      ),
      "utf8",
    );
    expect(disk.trim().split("\n")).toHaveLength(3);
    expect(disk).toContain(first.id);
  });
});
