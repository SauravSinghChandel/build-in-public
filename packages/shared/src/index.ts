import { z } from "zod";
const id = z.uuid();
const stamp = z.iso.datetime();
const platform = z.enum(["x", "linkedin"]);
export const Project = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  name: z.string(),
  rootCommit: z.string(),
  remoteUrl: z.string().optional(),
  lastSharedCommit: z.string().nullable().default(null),
  lastSharedDate: z.string().optional(),
  commitContext: z.boolean(),
  settings: z.strictObject({
    tone: z.string().optional(),
    allowEmoji: z.boolean().optional(),
    lastAgent: z.record(z.string(), z.enum(["claude", "codex"])).optional(),
    audience: z.string().optional(),
    defaultPlatforms: z.array(platform).optional(),
  }),
});
export const Story = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  title: z.string(),
  brief: z.string(),
  status: z.enum(["idea", "drafting", "ready", "published", "archived"]),
  commitRange: z.strictObject({ from: z.string(), to: z.string() }).optional(),
  compositionIds: z.array(z.string()),
  selectedCommits: z.array(z.string()).optional(),
  angle: z.string().optional(),
  createdAt: stamp,
  updatedAt: stamp,
});
const postFields = {
  id,
  storyId: id,
  platform,
  kind: z.enum(["post", "thread", "follow_up"]),
  derivedFromPostId: id.optional(),
  replyToPostId: id.optional(),
  currentRevisionId: z.string(),
  approvedRevisionId: id.optional(),
  status: z.enum([
    "draft",
    "approved",
    "scheduled",
    "publishing",
    "published",
    "failed",
    // A create call failed after sending: it may be live. Never retried automatically.
    "uncertain",
  ]),
  scheduledAt: stamp.optional(),
  publishedAt: stamp.optional(),
  publishedUrl: z.url().optional(),
  externalId: z.string().optional(),
  /** Every published part id, in order (X threads have one per part). */
  externalIds: z.array(z.string()).optional(),
  error: z.string().optional(),
};
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const PostV1 = z.strictObject({
  ...postFields,
  schemaVersion: z.literal(1),
  media: z.array(z.strictObject({ assetSha: sha, alt: z.string().optional() })),
});
export const Post = z.strictObject({
  ...postFields,
  schemaVersion: z.literal(2),
  media: z.array(z.strictObject({ sha, alt: z.string().optional() })),
});
export const Revision = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  parts: z.array(z.string()).min(1),
  instruction: z.string().optional(),
  author: z.enum(["user", "agent"]),
  agentRunId: z.string().optional(),
  createdAt: stamp,
  editedAt: stamp.optional(),
  coalescesRevisionId: id.optional(),
  claims: z.array(z.string()).optional(),
  highlights: z.array(z.string()).optional(),
});

export const ScanInput = z.strictObject({
  root: z.string().min(1),
  depth: z.number().int().min(1).max(3).default(2),
});
export const TrackInput = z.strictObject({
  paths: z.array(z.string().min(1)).min(1).max(100),
});
export const ProjectPatch = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  settings: Project.shape.settings.optional(),
});
export const ContextInput = z.strictObject({
  shareable: z.string().max(1000000),
  private: z.string().max(1000000),
});
export const LocateInput = z.strictObject({ path: z.string().min(1) });
export const MarkInput = z.strictObject({
  sha: z.string().regex(/^[a-f0-9]{40,64}$/),
});
export const ToggleInput = z.strictObject({ enabled: z.boolean() });
export const DeleteInput = z.strictObject({ confirmName: z.string() });
export const PageInput = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ProjectData = z.infer<typeof Project>;
export interface GitInfo {
  branch: string;
  head: string;
  rootCommit: string;
  remoteUrl: string | null;
  lastCommitAt: string | null;
}
export interface Commit {
  sha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  date: string;
  files: { path: string; insertions: number; deletions: number }[];
  insertions: number;
  deletions: number;
}
export interface ProjectRow
  extends Omit<ProjectData, "remoteUrl">, Omit<GitInfo, "remoteUrl"> {
  remoteUrl?: string;
  path: string;
  status: "active" | "missing" | "archived";
  currentUserEmail?: string;
  currentUserName?: string;
  unsharedCount: number;
  markerLost: boolean;
  lastPostAt: string | null;
  readOnly: boolean;
  bipSize: number;
}
export interface TrackedDir {
  id: string;
  path: string;
  depth: number;
  last_scanned_at: string | null;
}
export interface DiscoveredRepo extends GitInfo {
  path: string;
  name: string;
  tracked: boolean;
  /** Set when the folder has a .git entry Git cannot use. */
  invalid?: boolean;
  reason?: string;
  /** A copyable shell command that would repair the repository; never run by BIP. */
  fix?: string;
}
export interface AgentStatus {
  id: string;
  installed: boolean;
  version?: string;
  auth: "signed in" | "not signed in" | "unknown";
  hint: string;
  usable?: boolean;
}
export interface Check {
  name: string;
  ok: boolean;
  hard: boolean;
  hint: string;
}
export interface Versions {
  bip: string;
  hyperframes?: string;
  playwright?: string;
  claude?: string;
  codex?: string;
}
export interface DoctorReport {
  checks: Check[];
  dataPath: string;
  backups: string[];
  versions?: Versions;
}

export type StoryData = z.infer<typeof Story>;
export type PostData = z.infer<typeof Post>;
export type RevisionData = z.infer<typeof Revision>;
export const Angle = z.strictObject({
  title: z.string(),
  hook: z.string(),
  why_interesting: z.string(),
  commits: z.array(z.string()),
});
export const Angles = z.strictObject({ angles: z.array(Angle).length(3) });
export const Draft = z.strictObject({
  x: z.strictObject({ parts: z.array(z.string()).min(1).max(4) }),
  linkedin: z.strictObject({ text: z.string() }),
  highlights: z.array(z.string()),
  claims_to_verify: z.array(z.string()),
});
export function editSchema(platform: "x" | "linkedin") {
  return Draft.pick(
    platform === "x"
      ? { x: true, highlights: true, claims_to_verify: true }
      : { linkedin: true, highlights: true, claims_to_verify: true },
  );
}
export function textLength(text: string, platform: "x" | "linkedin") {
  return [
    ...(platform === "x"
      ? text.replace(/https?:\/\/[^\s]+/gi, "x".repeat(23))
      : text),
  ].length;
}
export function validateParts(parts: string[], platform: "x" | "linkedin") {
  const warnings: string[] = [];
  if (platform === "x" && parts.length > 4)
    warnings.push("X threads have at most 4 parts");
  parts.forEach((text, i) => {
    const n = textLength(text, platform);
    if (platform === "x" ? n > 280 : n < 600 || n > 1200)
      warnings.push(
        `${platform === "x" ? `Part ${i + 1}` : "LinkedIn"}: ${n} characters. ${n > (platform === "x" ? 280 : 1200) ? "Shorten" : "Expand"} suggested`,
      );
    if ((text.match(/#[\p{L}\p{N}_]+/gu) || []).length > 1)
      warnings.push("Use at most one hashtag");
  });
  return warnings;
}
export function publishUrl(value: string, platform: "x" | "linkedin") {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (platform === "x"
        ? ["x.com", "www.x.com", "twitter.com", "www.twitter.com"]
        : ["linkedin.com", "www.linkedin.com"]
      ).includes(url.hostname) &&
      url.pathname !== "/"
    );
  } catch {
    return false;
  }
}
export function intentUrl(parts: string[], platform: "x" | "linkedin") {
  const encoded = encodeURIComponent(parts[0] || "");
  if (platform === "x") return `https://x.com/intent/post?text=${encoded}`;
  const url = `https://www.linkedin.com/feed/?shareActive=true&text=${encoded}`;
  return url.length > 2000 ? "https://www.linkedin.com/feed/" : url;
}
/** A scheduled post more than this late is Overdue and is never auto-posted. */
export const SCHEDULE_GRACE_MS = 2 * 60 * 1000;
export function isOverdue(
  post: { status: string; scheduledAt?: string },
  now = Date.now(),
) {
  return (
    post.status === "scheduled" &&
    !!post.scheduledAt &&
    Date.parse(post.scheduledAt) < now - SCHEDULE_GRACE_MS
  );
}
export type PlatformId = "x" | "linkedin";
export interface AccountInfo {
  id: string;
  platform: PlatformId;
  handle: string;
  displayName?: string;
  scopes: string[];
  expiresAt: string | null;
  /** LinkedIn: tokens last about 60 days. */
  reconnectBy: string | null;
  expiry: "ok" | "soon" | "expired";
  createdAt: string;
}
export interface PlatformAccountsView {
  platform: PlatformId;
  redirectUri: string;
  scopes: string[];
  app: { clientId: string; hasSecret: boolean } | null;
  account: AccountInfo | null;
}
export interface AccountsView {
  /** null when requested with `?metadata=1` (no keychain access). */
  secretStore: { kind: "keychain" | "file"; warning?: string } | null;
  platforms: PlatformAccountsView[];
}
export interface PostView {
  post: PostData;
  revisions: RevisionData[];
  warnings: string[];
  claims: string[];
  highlights: string[];
}
export interface StoryView {
  story: StoryData;
  posts: PostView[];
}
export interface JobView {
  id: string;
  type: string;
  status: string;
  project_id: string;
  resource_key: string;
  payload: Record<string, any>;
  result: any;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  partial?: string;
}

export const ImageSize = z.enum(["x", "linkedin", "square", "portrait"]);
export const imageSizes = {
  x: [1200, 675],
  linkedin: [1200, 627],
  square: [1080, 1080],
  portrait: [1080, 1350],
} as const;
export const ImagePreset = z.enum([
  "minimal",
  "launch",
  "technical",
  "comparison",
]);
export const CaptureStep = z
  .strictObject({
    action: z.enum([
      "click",
      "type",
      "scroll",
      "hover",
      "wait",
      "press",
      "pause",
      "scrollTo",
    ]),
    selector: z.string().max(1000).optional(),
    text: z.string().max(10000).optional(),
    value: z.union([z.string().max(1000), z.number().finite()]).optional(),
    y: z.number().finite().optional(),
    durationMs: z.number().int().min(1).max(30000).optional(),
    ms: z.number().int().min(0).max(30000).optional(),
  })
  .superRefine((s, c) => {
    if (["click", "type", "hover"].includes(s.action) && !s.selector)
      c.addIssue({ code: "custom", message: "This action needs a selector" });
    if (s.action === "type" && s.text === undefined)
      c.addIssue({ code: "custom", message: "Type needs text" });
    if (s.action === "pause" && s.ms === undefined)
      c.addIssue({ code: "custom", message: "Pause needs ms" });
    if (
      s.action === "scrollTo" &&
      ((!s.selector && s.y === undefined) || s.durationMs === undefined)
    )
      c.addIssue({
        code: "custom",
        message: "scrollTo needs selector or y and durationMs",
      });
    if (
      s.action === "scroll" &&
      s.value !== undefined &&
      !Number.isFinite(Number(s.value))
    )
      c.addIssue({ code: "custom", message: "Scroll needs numeric value" });
    if (s.action === "press" && typeof s.value !== "string")
      c.addIssue({ code: "custom", message: "Press needs a key value" });
  });
export const CaptureInput = z.strictObject({
  url: z
    .url()
    .refine(
      (v) => ["http:", "https:"].includes(new URL(v).protocol),
      "Use http or https",
    ),
  viewport: z.enum(["1440x900", "1280x800", "390x844"]).default("1440x900"),
  fullPage: z.boolean().default(false),
  selector: z.string().max(1000).optional(),
  waitFor: z.enum(["networkidle", "selector", "delay"]).default("networkidle"),
  waitSelector: z.string().optional(),
  delay: z.number().int().min(0).max(30000).default(1000),
  steps: z.array(CaptureStep).max(50).default([]),
});
export const Asset = z.object({
  sha,
  kind: z.enum([
    "screenshot",
    "upload",
    "image_render",
    "recording",
    "event_log",
    "scene_log",
    "video_render",
    "contact_sheet",
  ]),
  mime: z.enum([
    "image/png",
    "image/jpeg",
    "image/webp",
    "video/mp4",
    "video/quicktime",
    "video/webm",
    "application/json",
  ]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationMs: z.number().positive().optional(),
  hasAudio: z.boolean().optional(),
  quality: z
    .object({
      effectiveFps: z.number(),
      maxGapMs: z.number(),
      choppy: z.boolean(),
    })
    .optional(),
  createdAt: stamp,
  provenance: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("capture"),
      url: z.string(),
      steps: z.array(CaptureStep).optional(),
      viewport: z.object({
        width: z.number(),
        height: z.number(),
        dpr: z.literal(2),
      }),
    }),
    z.object({ type: z.literal("upload"), filename: z.string() }),
    z.object({
      type: z.literal("video_capture"),
      url: z.string(),
      steps: z.array(CaptureStep),
      eventLogSha: sha,
    }),
    z.object({
      type: z.literal("video_import"),
      filename: z.string(),
      scenesSha: sha,
    }),
    z.object({
      type: z.literal("video_still"),
      recordingSha: sha,
      timeMs: z.number().nonnegative(),
    }),
    z.object({
      type: z.literal("recording_log"),
      filename: z.enum(["events.json", "scenes.json"]),
    }),
    z.object({
      type: z.literal("render"),
      compositionId: z.string(),
      commit: z.string(),
      variant: z.string().optional(),
      frameHash: z.string().optional(),
      hashFrame: z.number().int().nonnegative().optional(),
    }),
  ]),
});
export type AssetData = z.infer<typeof Asset>;
export const Composition = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  type: z.literal("image"),
  title: z.string().max(200),
  preset: ImagePreset,
  width: z.number().int().min(100).max(2400),
  height: z.number().int().min(100).max(2400),
  slots: z.strictObject({
    headline: z.string().max(300),
    subhead: z.string().max(1000),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    background: z.enum(["solid", "radial", "noise", "dominant"]),
    frame: z.enum(["none", "browser", "window", "phone"]),
    padding: z.number().min(16).max(120),
    shadow: z.number().min(0).max(100),
    annotations: z.array(z.string().max(120)).max(3),
  }),
  sources: z.array(sha).min(1).max(2),
  allowScreenshotEdits: z.boolean().default(false),
  storyId: z.uuid().optional(),
});
export type CompositionData = z.infer<typeof Composition>;
export interface ImageRevision {
  commit: string;
  instruction: string;
  createdAt: string;
}
export interface CompositionView {
  composition: CompositionData;
  commit: string;
  revisions: ImageRevision[];
  previewUrl: string;
  fidelity?: { pass: boolean; errors: string[]; diffs?: unknown[] };
}

export const VideoCaptureInput = z.strictObject({
  url: CaptureInput.shape.url,
  viewport: CaptureInput.shape.viewport,
  steps: z.array(CaptureStep).max(50),
  approved: z.literal(true),
  storyId: z.uuid().optional(),
});
export const VideoScene = z
  .strictObject({
    id: z.string().min(1).max(100),
    kind: z.enum(["title", "recording", "still", "outro"]),
    startMs: z.number().nonnegative(),
    endMs: z.number().positive(),
    sourceSha: sha.optional(),
    notes: z.string().max(2000),
  })
  .refine((s) => s.endMs > s.startMs, "Scene must end after start")
  .refine(
    (s) => s.kind !== "recording" || !!s.sourceSha,
    "Recording scene needs a source",
  );
export const VideoCaption = z
  .strictObject({
    text: z.string().max(1000),
    startMs: z.number().nonnegative(),
    endMs: z.number().positive(),
  })
  .refine((s) => s.endMs > s.startMs, "Caption must end after start");
export const VideoComposition = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    type: z.literal("video"),
    title: z.string().max(200),
    fps: z.literal(30),
    durationMs: z.number().min(100).max(600000),
    style: z.enum(["clean", "technical"]),
    sources: z.array(sha).min(1).max(30),
    storyId: z.uuid().optional(),
    scenes: z.array(VideoScene).min(1).max(100),
    captions: z.array(VideoCaption).max(100),
  })
  .superRefine((v, c) => {
    for (const s of [...v.scenes, ...v.captions])
      if (s.endMs > v.durationMs)
        c.addIssue({
          code: "custom",
          message: "Scene/caption exceeds duration",
        });
    for (const s of v.scenes)
      if (s.sourceSha && !v.sources.includes(s.sourceSha))
        c.addIssue({ code: "custom", message: "Scene source is not declared" });
    if (new Set(v.scenes.map((s) => s.id)).size !== v.scenes.length)
      c.addIssue({ code: "custom", message: "Duplicate scene id" });
  });
export type VideoCompositionData = z.infer<typeof VideoComposition>;
export interface VideoRevision extends ImageRevision {
  diffStat: string;
  largeChange: boolean;
  contactSha?: string;
  previewSha?: string;
  finalSha?: string;
  squareSha?: string;
  verticalSha?: string;
}
export interface VideoView {
  composition: VideoCompositionData;
  commit: string;
  revisions: VideoRevision[];
  clicks: { t: number; x: number; y: number }[];
  choppy: boolean;
}

/** Result of dry-running one generated step's selector against the live page. */
export interface StepCheck {
  status: "ok" | "missing" | "ambiguous" | "invalid" | "none";
  count?: number;
  message?: string;
}
export interface PageElement {
  role: string;
  name: string;
  text?: string;
  href?: string;
  selector: string;
}
/** Separates a friendly job error from its raw log (shown behind a "Details" toggle). */
export const ERROR_DETAILS = "\n\n--- Details ---\n";
// eslint-disable-next-line no-control-regex
const ansi =
  /[\u001b\u009b](?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
export function stripAnsi(text: string) {
  return text.replace(ansi, "");
}
export function splitJobError(error: string | null | undefined) {
  if (!error) return { message: "", details: "" };
  const at = error.indexOf(ERROR_DETAILS);
  return at < 0
    ? { message: error, details: "" }
    : {
        message: error.slice(0, at),
        details: error.slice(at + ERROR_DETAILS.length),
      };
}
