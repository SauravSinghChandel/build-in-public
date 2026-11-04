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
  extends Omit<ProjectData, "remoteUrl">,
    Omit<GitInfo, "remoteUrl"> {
  remoteUrl?: string;
  path: string;
  status: "active" | "missing" | "archived";
  currentUserEmail?: string;
  unsharedCount: number;
  markerLost: boolean;
  lastPostAt: null;
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
