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
  ]),
  scheduledAt: stamp.optional(),
  publishedAt: stamp.optional(),
  publishedUrl: z.url().optional(),
  externalId: z.string().optional(),
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
export interface DoctorReport {
  checks: Check[];
  dataPath: string;
  backups: string[];
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
    action: z.enum(["click", "type", "scroll", "hover", "wait", "press"]),
    selector: z.string().max(1000).optional(),
    text: z.string().max(10000).optional(),
    value: z.union([z.string().max(1000), z.number().finite()]).optional(),
    ms: z.number().int().min(0).max(30000).optional(),
  })
  .superRefine((s, c) => {
    if (["click", "type", "hover"].includes(s.action) && !s.selector)
      c.addIssue({ code: "custom", message: "This action needs a selector" });
    if (s.action === "type" && s.text === undefined)
      c.addIssue({ code: "custom", message: "Type needs text" });
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
  kind: z.enum(["screenshot", "upload", "image_render"]),
  mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
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
      type: z.literal("render"),
      compositionId: z.string(),
      commit: z.string(),
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
