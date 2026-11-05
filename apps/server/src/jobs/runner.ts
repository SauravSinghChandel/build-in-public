import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { JobView } from "@bip/shared";
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
export class JobRunner {
  readonly events = new EventRing();
  private active = new Map<
    string,
    { key: string; controller: AbortController; done: Promise<void> }
  >();
  private stopped = false;
  constructor(
    readonly db: Database.Database,
    private handler: JobHandler,
  ) {
    db.prepare(
      "UPDATE jobs SET status='interrupted',error='Server stopped during generation' WHERE status='running'",
    ).run();
  }
  start() {
    this.pump();
  }
  list(): JobView[] {
    return (
      this.db.prepare("SELECT * FROM jobs ORDER BY rowid").all() as any[]
    ).map((r) => ({
      ...r,
      payload: JSON.parse(r.payload_json || "{}"),
      result: r.result_json ? JSON.parse(r.result_json) : null,
    }));
  }
  get(id: string) {
    const job = this.list().find((j) => j.id === id);
    if (!job) throw Error("Job not found");
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
      throw Error("Only stopped jobs can resume");
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
    for (const job of this.list().filter((j) => j.status === "queued")) {
      if (this.active.size >= 2) break;
      if ([...this.active.values()].some((a) => a.key === job.resource_key))
        continue;
      const controller = new AbortController();
      this.db
        .prepare(
          "UPDATE jobs SET status='running',started_at=?,attempts=attempts+1 WHERE id=?",
        )
        .run(new Date().toISOString(), job.id);
      const entry = {
        key: job.resource_key,
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
    } catch (e) {
      const status = signal.aborted ? "cancelled" : "failed";
      const error = e instanceof Error ? e.message : String(e);
      this.db
        .prepare("UPDATE jobs SET status=?,error=?,finished_at=? WHERE id=?")
        .run(status, error, new Date().toISOString(), job.id);
      this.events.publish(job.id, status, { error });
    }
  }
  async close() {
    this.stopped = true;
    for (const a of this.active.values()) a.controller.abort();
    await Promise.all([...this.active.values()].map((a) => a.done));
  }
}
