import {
  isOverdue,
  publishUrl,
  type AccountInfo,
  type PostView,
  type RevisionData,
} from "@bip/shared";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../api";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { message, useRefresh } from "../../components/workspace";
import { PublishImages } from "../image/Attachments";
import { accountLabel, useAccountMetadata } from "../settings/Accounts";

export const SCHEDULER_NOTE =
  "Scheduled posts go out only while Build in Public is running. Posts missed while it was closed wait for you as Overdue.";
export const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
export const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
/** `datetime-local` value for a Date in the browser's timezone. */
function localValue(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function useAccount(platform: string): AccountInfo | null {
  const accounts = useAccountMetadata();
  return (
    accounts.data?.platforms.find((p) => p.platform === platform)?.account ??
    null
  );
}

/** "Post now via <account>" and "Schedule…" for an approved post (M5). */
export function DirectPublish({
  pId,
  view,
  revision,
}: {
  pId: string;
  view: PostView;
  revision: RevisionData;
}) {
  const { post } = view;
  const account = useAccount(post.platform);
  const [confirming, setConfirming] = useState(false),
    [scheduling, setScheduling] = useState(false),
    [at, setAt] = useState(() =>
      localValue(new Date(Date.now() + 60 * 60 * 1000)),
    ),
    [busy, setBusy] = useState(false),
    [postedUrl, setPostedUrl] = useState("");
  const refresh = useRefresh();
  const base = `/projects/${pId}/stories/${post.storyId}/posts/${post.id}`;
  if (!account) return null;
  const label = accountLabel(account);
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) toast.success(done);
      refresh();
      return true;
    } catch (e) {
      message(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const postNow = () =>
    void run(
      () => api(base + "/post-now", "POST", { revisionId: revision.id }),
      `Posting via ${label}`,
    ).then((ok) => ok && setConfirming(false));
  const schedule = () =>
    void run(
      () =>
        api(base + "/schedule", "POST", {
          revisionId: revision.id,
          scheduledAt: new Date(at).toISOString(),
        }),
      "Scheduled",
    ).then((ok) => ok && setScheduling(false));
  const expired = account.expiry === "expired";
  if (post.status === "uncertain")
    return (
      <div className="direct-publish" role="group" aria-label="May have posted">
        <h3>May have posted</h3>
        <p role="alert" className="error">
          {post.error}
        </p>
        <label className="field">
          It posted: paste its link
          <input
            value={postedUrl}
            onChange={(e) => setPostedUrl(e.target.value)}
            placeholder={
              post.platform === "x"
                ? "https://x.com/you/status/…"
                : "https://www.linkedin.com/feed/update/…"
            }
          />
        </label>
        <div className="actions">
          <Button
            variant="default"
            disabled={busy || !publishUrl(postedUrl, post.platform)}
            onClick={() =>
              void run(
                () => api(base + "/confirm-posted", "POST", { url: postedUrl }),
                "Recorded as posted",
              )
            }
          >
            It posted
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              if (
                confirm(
                  "Retry anyway? If the post is already live this creates a duplicate. Check your profile first.",
                )
              )
                void run(
                  () =>
                    api(base + "/post-now", "POST", {
                      revisionId: revision.id,
                      retryUncertain: true,
                    }),
                  `Posting via ${label}`,
                );
            }}
          >
            Retry anyway
          </Button>
        </div>
      </div>
    );
  return (
    <div className="direct-publish">
      <h3>Post directly</h3>
      {post.status === "publishing" && <p className="chip">Posting…</p>}
      {post.status === "failed" && post.error && (
        <p role="alert" className="error">
          {post.error}
        </p>
      )}
      {post.status === "scheduled" && post.scheduledAt && (
        <p className={isOverdue(post) ? "error" : ""}>
          {isOverdue(post) ? "Overdue: was scheduled for " : "Scheduled for "}
          {when(post.scheduledAt)} via {label}
        </p>
      )}
      {expired && (
        <p className="error">
          Your {post.platform === "x" ? "X" : "LinkedIn"} sign-in expired.
          Reconnect in Settings → Accounts.
        </p>
      )}
      <div className="actions">
        <Button
          variant="default"
          disabled={busy || expired || post.status === "publishing"}
          onClick={() => setConfirming(true)}
        >
          {post.status === "failed" ? "Retry" : `Post now via ${label}`}
        </Button>
        {post.status === "scheduled" ? (
          <>
            <Button disabled={busy} onClick={() => setScheduling(true)}>
              Reschedule
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void run(() => api(base + "/unschedule", "POST"), "Unscheduled")
              }
            >
              Unschedule
            </Button>
          </>
        ) : (
          <Button
            disabled={busy || expired || post.status === "publishing"}
            onClick={() => setScheduling(true)}
          >
            Schedule…
          </Button>
        )}
      </div>
      {scheduling && (
        <div className="schedule-form">
          <label className="field">
            Post at ({timeZone()})
            <input
              type="datetime-local"
              step={1}
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </label>
          <p className="muted small">{SCHEDULER_NOTE}</p>
          <div className="actions">
            <Button
              variant="default"
              disabled={busy || !at}
              onClick={schedule}
            >
              Schedule
            </Button>
            <Button onClick={() => setScheduling(false)}>Cancel</Button>
          </div>
        </div>
      )}
      {confirming && (
        <Dialog
          open
          onOpenChange={(v) => !v && setConfirming(false)}
          title={`Post to ${post.platform === "x" ? "X" : "LinkedIn"} as ${label}?`}
          description="This posts immediately. It's exactly what will be published."
        >
          <div className="publish-sheet">
            {revision.parts.map((part, i) => (
              <div className="post-preview" key={i}>
                {revision.parts.length > 1 && (
                  <p className="muted small">
                    Part {i + 1} of {revision.parts.length}
                  </p>
                )}
                <p>{part}</p>
              </div>
            ))}
            <PublishImages project={pId} post={post} />
            <p>
              Account: <strong>{label}</strong>
            </p>
            <div className="actions">
              <Button variant="default" disabled={busy} onClick={postNow}>
                Confirm and post
              </Button>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
