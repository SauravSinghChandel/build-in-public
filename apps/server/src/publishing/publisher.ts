import {
  publishUrl,
  SCHEDULE_GRACE_MS,
  type JobView,
  type PlatformId,
  type PostData,
} from "@bip/shared";
import type { Content } from "../content.js";
import { advanceMarker } from "../content.js";
import type { Assets } from "../image/assets.js";
import type { Accounts } from "./accounts.js";
import { PlatformError, type MediaFile } from "./platforms.js";

export const CHANGED_AFTER_APPROVAL =
  "This post changed after approval. Review and approve it again.";
export const CHECK_BEFORE_RETRY =
  "This post may already be live. Check your profile, then choose It posted or Retry anyway.";
type Store = Awaited<ReturnType<Content["projects"]["store"]>>;
type Emit = (type: string, data?: Record<string, unknown>) => void;

export function checkMedia(platform: PlatformId, mimes: string[]) {
  const videos = mimes.filter((m) => m.startsWith("video/")).length;
  if (videos > 1 || (videos && mimes.length > 1))
    throw Error(
      `${platform === "x" ? "X" : "LinkedIn"} posts take either images or one video.`,
    );
  if (platform === "x" && mimes.length > 4)
    throw Error("X posts take at most 4 images.");
  if (platform === "linkedin" && mimes.length > 20)
    throw Error("LinkedIn posts take at most 20 images.");
}

export function publishedUrlFor(platform: PlatformId, handle: string, id: string) {
  return platform === "x"
    ? `https://x.com/${encodeURIComponent(handle)}/status/${encodeURIComponent(id)}`
    : `https://www.linkedin.com/feed/update/${id}/`;
}

export class Publisher {
  /** Test hook: runs right after an external id is persisted (simulates a crash). */
  afterPersist?: (part: number) => void | Promise<void>;
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<number>;
  constructor(
    readonly content: Content,
    readonly accounts: Accounts,
    readonly assets: Assets,
    private options: { now?: () => number; intervalMs?: number } = {},
  ) {
    content.publishHandler = (job, signal, emit) => this.handle(job, signal, emit);
  }
  now() {
    return this.options.now?.() ?? Date.now();
  }
  private async approvedPost(
    projectId: string,
    storyId: string,
    postId: string,
    revisionId: string,
    retryUncertain = false,
  ) {
    const s = await this.content.projects.store(projectId);
    if (s.readOnly) throw Error("Project is read-only");
    const post = await s.readPost(storyId, postId);
    if (post.status === "published") throw Error("This post is already published");
    if (post.status === "uncertain" && !retryUncertain) throw Error(CHECK_BEFORE_RETRY);
    if (this.activeJob(postId))
      throw Error("This post is already being published");
    assertApproved(post, revisionId);
    const account = this.accounts.info(post.platform);
    if (!account)
      throw Error(
        `Connect a ${post.platform === "x" ? "X" : "LinkedIn"} account in Settings → Accounts`,
      );
    if (account.expiry === "expired")
      throw Error("Reconnect your account: the LinkedIn sign-in expired.");
    const mimes = await this.mimes(projectId, post);
    checkMedia(post.platform, mimes);
    return { s, post, account };
  }
  private activeJob(postId: string) {
    return this.content.db
      .prepare(
        "SELECT id FROM jobs WHERE type='publish' AND resource_key=? AND status IN ('queued','running') LIMIT 1",
      )
      .get(`post:${postId}`) as { id: string } | undefined;
  }
  private async mimes(projectId: string, post: PostData) {
    const items = await this.assets.list(projectId);
    return post.media.map((m) => {
      const item = items.find((a) => a.sha === m.sha);
      if (!item) throw Error("An attached media file is missing");
      return item.mime;
    });
  }
  private async enqueue(
    s: Store,
    projectId: string,
    post: PostData,
    revisionId: string,
    trigger: "now" | "schedule",
    retryUncertain = false,
  ) {
    await s.updatePost(
      post.storyId,
      post.id,
      { status: "publishing", error: undefined, scheduledAt: undefined },
      revisionId,
    );
    return this.content.jobs.enqueue("publish", projectId, `post:${post.id}`, {
      storyId: post.storyId,
      postId: post.id,
      revisionId,
      platform: post.platform,
      trigger,
      ...(retryUncertain ? { retryUncertain: true } : {}),
    });
  }
  /** `retryUncertain`: the user checked their profile and chose "Retry anyway". */
  async postNow(
    projectId: string,
    storyId: string,
    postId: string,
    revisionId: string,
    retryUncertain = false,
  ) {
    const { s, post } = await this.approvedPost(
      projectId,
      storyId,
      postId,
      revisionId,
      retryUncertain,
    );
    return this.enqueue(s, projectId, post, revisionId, "now", retryUncertain);
  }
  /**
   * "It posted": the user found the uncertain part live and pastes its link. Records
   * it like an API success (threads continue from the next part on Retry).
   */
  async confirmPosted(projectId: string, storyId: string, postId: string, url: string) {
    const s = await this.content.projects.store(projectId);
    const post = await s.readPost(storyId, postId);
    if (post.status !== "uncertain") throw Error("Only a post that may have posted can be confirmed");
    if (!publishUrl(url, post.platform))
      throw Error("Use a published HTTPS link from the matching platform");
    assertApproved(post, post.currentRevisionId);
    const revision = (await s.readRevisions(storyId, postId)).revisions.find(
      (r) => r.id === post.currentRevisionId,
    )!;
    const total = post.platform === "x" ? revision.parts.length : 1;
    const id =
      post.platform === "x"
        ? new URL(url).pathname.match(/\/status\/(\d+)/)?.[1]
        : decodeURIComponent(url).match(/urn:li:(?:share|ugcPost|activity):\d+/)?.[0];
    if (post.platform === "x" && !id) throw Error("Paste the post's link (…/status/<id>)");
    const ids = [...(post.externalIds ?? []), ...(id ? [id] : [])];
    await s.updatePost(storyId, postId, {
      ...(ids.length ? { externalId: ids[0], externalIds: ids } : {}),
    });
    if (ids.length < total && post.platform === "x") {
      return s.updatePost(storyId, postId, {
        status: "failed",
        error: `Posted ${ids.length} of ${total} parts. Retry continues from part ${ids.length + 1}.`,
      });
    }
    const handle = this.accounts.info(post.platform)?.handle;
    const link =
      post.platform === "x" && total > 1 && handle
        ? publishedUrlFor("x", handle, ids[0])
        : url;
    return this.finish(s, post, link);
  }
  private async finish(s: Store, post: PostData, publishedUrl: string) {
    const others = await s.listPosts(post.storyId);
    const first = !others.some((p) => p.id !== post.id && p.status === "published");
    const done = await s.updatePost(post.storyId, post.id, {
      status: "published",
      publishedAt: new Date(this.now()).toISOString(),
      publishedUrl,
      error: undefined,
      scheduledAt: undefined,
    });
    const story = await s.updateStory(post.storyId, { status: "published" });
    if (first && story.commitRange?.to) await advanceMarker(s, story.commitRange.to);
    return done;
  }
  async schedule(
    projectId: string,
    storyId: string,
    postId: string,
    revisionId: string,
    scheduledAt: string,
  ) {
    const t = Date.parse(scheduledAt);
    if (!Number.isFinite(t) || t <= this.now())
      throw Error("Pick a time in the future");
    if (t > this.now() + 366 * 24 * 60 * 60 * 1000)
      throw Error("Schedule at most a year ahead");
    const { s } = await this.approvedPost(projectId, storyId, postId, revisionId);
    return s.updatePost(
      storyId,
      postId,
      { status: "scheduled", scheduledAt: new Date(t).toISOString(), error: undefined },
      revisionId,
    );
  }
  async unschedule(projectId: string, storyId: string, postId: string) {
    const s = await this.content.projects.store(projectId);
    const post = await s.readPost(storyId, postId);
    if (post.status !== "scheduled") throw Error("This post isn't scheduled");
    return s.updatePost(storyId, postId, {
      status:
        post.approvedRevisionId === post.currentRevisionId ? "approved" : "draft",
      scheduledAt: undefined,
    });
  }
  /**
   * One scheduler pass: enqueue posts that are due (at most SCHEDULE_GRACE_MS late).
   * Anything later is Overdue and waits for the user. Also releases posts stuck in
   * "publishing" whose job stopped (server restart, cancel).
   */
  tick() {
    this.ticking ??= this.scan().finally(() => (this.ticking = undefined));
    return this.ticking;
  }
  private async scan() {
    const now = this.now();
    let enqueued = 0;
    for (const p of this.content.projects
      .registry()
      .filter((p) => p.status === "active")) {
      let s: Store;
      try {
        s = await this.content.projects.store(p.id);
      } catch {
        continue;
      }
      if (s.readOnly) continue;
      for (const story of await s.listStories().catch(() => []))
        for (const post of await s.listPosts(story.id).catch(() => [] as PostData[])) {
          if (post.status === "publishing") await this.release(s, post);
          if (post.status !== "scheduled" || !post.scheduledAt) continue;
          const t = Date.parse(post.scheduledAt);
          if (t > now || now - t > SCHEDULE_GRACE_MS) continue;
          try {
            if (this.activeJob(post.id)) continue;
            if (post.approvedRevisionId !== post.currentRevisionId) {
              await s.updatePost(story.id, post.id, {
                status: "draft",
                scheduledAt: undefined,
                error: CHANGED_AFTER_APPROVAL,
              });
              continue;
            }
            await this.enqueue(s, p.id, post, post.currentRevisionId, "schedule");
            enqueued++;
          } catch (e) {
            await s
              .updatePost(story.id, post.id, {
                status: "failed",
                error: e instanceof Error ? e.message : String(e),
              })
              .catch(() => {});
          }
        }
    }
    return enqueued;
  }
  private async release(s: Store, post: PostData) {
    const last = this.content.db
      .prepare(
        "SELECT status FROM jobs WHERE type='publish' AND resource_key=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(`post:${post.id}`) as { status: string } | undefined;
    if (!last || ["queued", "running", "succeeded"].includes(last.status)) return;
    await s.updatePost(post.storyId, post.id, {
      status: "failed",
      error: partial(
        post,
        "Publishing stopped before it finished.",
      ),
    });
    post.status = "failed";
  }
  start() {
    const interval =
      this.options.intervalMs ?? (Number(process.env.BIP_SCHEDULER_INTERVAL_MS) || 30_000);
    const run = () => void this.tick().catch(() => {});
    run();
    this.timer = setInterval(run, interval);
    this.timer.unref();
  }
  async stop() {
    clearInterval(this.timer);
    await this.ticking?.catch(() => {});
  }
  /** `bip publish-due`: one pass, then wait for the publish jobs it started. */
  async runDue() {
    const before = new Set(this.content.jobs.list().map((j) => j.id));
    const enqueued = await this.tick();
    const mine = () =>
      this.content.jobs.list().filter((j) => j.type === "publish" && !before.has(j.id));
    while (mine().some((j) => ["queued", "running"].includes(j.status)))
      await new Promise((r) => setTimeout(r, 100));
    return { enqueued, jobs: mine() };
  }
  private async handle(job: JobView, signal: AbortSignal, emit: Emit) {
    const { storyId, postId, revisionId, retryUncertain } = job.payload as {
      storyId: string;
      postId: string;
      revisionId: string;
      retryUncertain?: boolean;
    };
    const s = await this.content.projects.store(job.project_id);
    let post = await s.readPost(storyId, postId);
    if (post.status === "published")
      return { publishedUrl: post.publishedUrl, externalIds: post.externalIds };
    let parts: string[] = [];
    try {
      // A plain Resume of an older job must not re-send a part that may be live.
      if (post.status === "uncertain" && !retryUncertain) throw Error(CHECK_BEFORE_RETRY);
      assertApproved(post, revisionId);
      if (post.status !== "publishing")
        post = await s.updatePost(storyId, postId, { status: "publishing", error: undefined });
      const { account, row, token } = await this.accounts.token(post.platform, signal);
      const revision = (await s.readRevisions(storyId, postId)).revisions.find(
        (r) => r.id === revisionId,
      );
      if (!revision) throw Error(CHANGED_AFTER_APPROVAL);
      parts = post.platform === "x" ? revision.parts : [revision.parts.join("\n\n")];
      // Idempotency: never re-send a part that already has an external id.
      let ids = post.externalIds ?? (post.externalId ? [post.externalId] : []);
      if (ids.length < parts.length) {
        let media: { id: string; alt?: string }[] = [];
        if (ids.length === 0 && post.media.length) {
          const files: MediaFile[] = [];
          for (const m of post.media) {
            const { item, bytes } = await this.assets.get(job.project_id, m.sha);
            files.push({ bytes, mime: item.mime, alt: m.alt || undefined });
          }
          checkMedia(post.platform, files.map((f) => f.mime));
          for (const [i, f] of files.entries()) {
            emit("progress", { message: `Uploading media ${i + 1} of ${files.length}…` });
            const id =
              post.platform === "x"
                ? await this.accounts.x(signal).upload(token, f)
                : await this.accounts
                    .linkedin(signal)
                    .upload(token, `urn:li:person:${row.external_user_id}`, f);
            media.push({ id, alt: f.alt });
          }
        }
        for (let i = ids.length; i < parts.length; i++) {
          if (signal.aborted) throw Error("Cancelled");
          // Re-check approval right before every API call that creates content.
          post = await s.readPost(storyId, postId);
          assertApproved(post, revisionId);
          emit("progress", {
            message:
              parts.length > 1 ? `Posting part ${i + 1} of ${parts.length}…` : "Posting…",
          });
          const id =
            post.platform === "x"
              ? await this.accounts.x(signal).createPost(token, {
                  text: parts[i],
                  mediaIds: i === 0 ? media.map((m) => m.id) : [],
                  replyTo: i > 0 ? ids[i - 1] : await this.replyTarget(s, post),
                })
              : await this.accounts.linkedin(signal).createPost(token, {
                  author: `urn:li:person:${row.external_user_id}`,
                  text: parts[i],
                  media,
                });
          ids = [...ids, id];
          // Persist the id first (always, even if the post changed meanwhile), then status.
          post = await s.updatePost(storyId, postId, { externalId: ids[0], externalIds: ids });
          await this.afterPersist?.(i);
        }
      }
      const publishedUrl = publishedUrlFor(post.platform, account.handle, ids[0]);
      await this.finish(s, post, publishedUrl);
      return { publishedUrl, externalIds: ids };
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const message = this.accounts.scrubber.scrub(raw);
      const latest = await s.readPost(storyId, postId).catch(() => post);
      if (e instanceof PlatformError && e.uncertain) {
        // Never retried automatically: the create call may have succeeded.
        const done = latest.externalIds?.length ?? 0;
        const text =
          parts.length > 1
            ? `Part ${done + 1} of ${parts.length}: ${message}${done === 1 ? " Part 1 is posted." : done ? ` Parts 1–${done} are posted.` : ""}`
            : message;
        if (latest.status === "publishing")
          await s
            .updatePost(storyId, postId, { status: "uncertain", error: text })
            .catch(() => {});
        throw Error(text);
      }
      if (latest.status === "publishing")
        await s
          .updatePost(storyId, postId, { status: "failed", error: partial(latest, message) })
          .catch(() => {});
      throw Error(partial(latest, message));
    }
  }
  /** X follow-ups reply to the last part of the post they follow. */
  private async replyTarget(s: Store, post: PostData) {
    if (!post.replyToPostId) return undefined;
    const parent = await s.readPost(post.storyId, post.replyToPostId).catch(() => null);
    if (!parent) return undefined;
    return (
      parent.externalIds?.at(-1) ??
      parent.publishedUrl?.match(/\/status\/(\d+)/)?.[1] ??
      undefined
    );
  }
}

export function assertApproved(post: PostData, revisionId: string) {
  if (
    !post.approvedRevisionId ||
    post.approvedRevisionId !== post.currentRevisionId ||
    post.currentRevisionId !== revisionId
  )
    throw Error(CHANGED_AFTER_APPROVAL);
}

function partial(post: PostData, message: string) {
  const done = post.externalIds?.length ?? 0;
  if (!done || message.startsWith("Posted ")) return message;
  return `Posted ${done} part${done === 1 ? "" : "s"}. ${message} Retry continues from part ${done + 1}.`;
}
