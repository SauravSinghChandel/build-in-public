import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { stripAnsi, type JobView } from "@bip/shared";
export interface Lifecycle {
  id: number;
  jobId: string;
  type: string;
  [key: string]: unknown;
}
export class EventRing {
  private sequence = 0;
  readonly events: Lifecycle[] = [];
  private listeners = new Set<(e: Lifecycle) => void>();
  constructor(private capacity = 300) {}
  publish(jobId: string, type: string, data: Record<string, unknown> = {}) {
    const e = { ...data, id: ++this.sequence, jobId, type };
    this.events.push(e);
    if (this.events.length > this.capacity) this.events.shift();
    for (const f of this.listeners) f(e);
    return e;
  }
  since(id: number) {
    return this.events.filter((e) => e.id > id);
  }
  subscribe(fn: (e: Lifecycle) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
export type JobHandler = (
  job: JobView,
  signal: AbortSignal,
  emit: (type: string, data?: Record<string, unknown>) => void,
) => Promise<unknown>;
/** Heavy renders get their own lane so agent jobs never queue behind them. */
const RENDER_JOBS = new Set(["video.preview", "video.contact", "video.final"]);
const LANE_CAPACITY = { render: 1, work: 2 } as const;
export const laneOf = (type: string): keyof typeof LANE_CAPACITY =>
  RENDER_JOBS.has(type) ? "render" : "work";

export class JobRunner {
  readonly events = new EventRing();
  private active = new Map<
    string,
    {
      key: string;
      lane: keyof typeof LANE_CAPACITY;
      controller: AbortController;
      done: Promise<void>;
    }
  >();
  private stopped = false;
  /** Failed and interrupted workspaces are kept this long for debugging. */
  static readonly KEEP_FAILED_MS = 7 * 24 * 60 * 60 * 1000;
  constructor(
    readonly db: Database.Database,
    private handler: JobHandler,
    /** Agent workspaces live at <workspaces>/<jobId>; cleaned up when set. */
    private workspaces?: string,
  ) {
    db.prepare(
      "UPDATE jobs SET status='interrupted',error='Server stopped during generation' WHERE status='running'",
    ).run();
  }
  start() {
    this.pump();
    return this.prune().catch(() => {});
  }
  private async removeWorkspace(jobId: string) {
    if (this.workspaces)
      await fs
        .rm(path.join(this.workspaces, jobId), { recursive: true, force: true })
        .catch(() => {});
  }
  /**
   * Deletes workspaces of succeeded, cancelled and unknown jobs, and of failed or
   * interrupted jobs older than KEEP_FAILED_MS. Queued and running jobs keep theirs.
   */
  async prune(now = Date.now()) {
    if (!this.workspaces) return [];
    const removed: string[] = [];
    const entries = await fs
      .readdir(this.workspaces, { withFileTypes: true })
      .catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const row = this.db
        .prepare("SELECT status FROM jobs WHERE id=?")
        .get(e.name) as { status: string } | undefined;
      if (row && ["queued", "running"].includes(row.status)) continue;
      if (row && ["failed", "interrupted"].includes(row.status)) {
        const { mtimeMs } = await fs.stat(path.join(this.workspaces, e.name));
        if (now - mtimeMs < JobRunner.KEEP_FAILED_MS) continue;
      }
      await this.removeWorkspace(e.name);
      removed.push(e.name);
    }
    return removed;
  }
  list(): JobView[] {
    return (
      this.db.prepare("SELECT * FROM jobs ORDER BY rowid DESC").all() as any[]
    ).map((r) => ({
      ...r,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      payload: JSON.parse(r.payload_json || "{}"),
      result: r.result_json ? JSON.parse(r.result_json) : null,
    }));
  }
  get(id: string) {
    const job = this.list().find((j) => j.id === id);
    if (!job) throw Error("That job no longer exists. Reload the page.");
    return job;
  }
  enqueue(
    type: string,
    projectId: string,
    key: string,
    payload: Record<string, unknown>,
  ) {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO jobs(id,type,status,project_id,resource_key,payload_json,created_at) VALUES(?,?,'queued',?,?,?,?)",
      )
      .run(
        id,
        type,
        projectId,
        key,
        JSON.stringify(payload),
        new Date().toISOString(),
      );
    this.events.publish(id, "queued");
    queueMicrotask(() => this.pump());
    return this.get(id);
  }
  cancel(id: string) {
    const job = this.get(id);
    if (job.status === "running") this.active.get(id)?.controller.abort();
    else if (job.status === "queued") {
      this.db
        .prepare("UPDATE jobs SET status='cancelled',finished_at=? WHERE id=?")
        .run(new Date().toISOString(), id);
      this.events.publish(id, "cancelled");
    }
    return this.get(id);
  }
  resume(id: string) {
    const job = this.get(id);
    if (!["interrupted", "cancelled", "failed"].includes(job.status))
      throw Error("Only stopped, failed or interrupted jobs can resume. Wait for this one to finish.");
    this.db
      .prepare(
        "UPDATE jobs SET status='queued',error=NULL,finished_at=NULL WHERE id=?",
      )
      .run(id);
    this.events.publish(id, "queued");
    queueMicrotask(() => this.pump());
    return this.get(id);
  }
  private pump() {
    if (this.stopped) return;
    for (const job of this.list()
      .reverse()
      .filter((j) => j.status === "queued")) {
      const lane = laneOf(job.type);
      const running = [...this.active.values()];
      if (running.filter((a) => a.lane === lane).length >= LANE_CAPACITY[lane])
        continue;
      if (running.some((a) => a.key === job.resource_key)) continue;
      const controller = new AbortController();
      this.db
        .prepare(
          "UPDATE jobs SET status='running',started_at=?,attempts=attempts+1 WHERE id=?",
        )
        .run(new Date().toISOString(), job.id);
      const entry = {
        key: job.resource_key,
        lane,
        controller,
        done: Promise.resolve(),
      };
      this.active.set(job.id, entry);
      this.events.publish(job.id, "running");
      entry.done = this.execute(this.get(job.id), controller.signal).finally(
        () => {
          this.active.delete(job.id);
          this.pump();
        },
      );
    }
  }
  private async execute(job: JobView, signal: AbortSignal) {
    try {
      const result = await this.handler(job, signal, (type, data) =>
        this.events.publish(job.id, type, data),
      );
      if (signal.aborted) throw Error("Cancelled");
      this.db
        .prepare(
          "UPDATE jobs SET status='succeeded',result_json=?,finished_at=?,progress=1 WHERE id=?",
        )
        .run(JSON.stringify(result ?? null), new Date().toISOString(), job.id);
      this.events.publish(job.id, "succeeded", { result });
      await this.removeWorkspace(job.id);
    } catch (e) {
      const status = signal.aborted ? "cancelled" : "failed";
      const error = stripAnsi(e instanceof Error ? e.message : String(e));
      this.db
        .prepare("UPDATE jobs SET status=?,error=?,finished_at=? WHERE id=?")
        .run(status, error, new Date().toISOString(), job.id);
      this.events.publish(job.id, status, { error });
      // Keep failed workspaces for debugging; prune() removes them after a week.
      if (status === "cancelled") await this.removeWorkspace(job.id);
    }
  }
  async close() {
    this.stopped = true;
    for (const a of this.active.values()) a.controller.abort();
    await Promise.all([...this.active.values()].map((a) => a.done));
  }
}
