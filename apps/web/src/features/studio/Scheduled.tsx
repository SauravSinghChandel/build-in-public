import { isOverdue } from "@bip/shared";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../api";
import { Button } from "../../components/ui/button";
import { message, useRefresh } from "../../components/workspace";
import type { Row } from "./ContentPage";
import { SCHEDULER_NOTE, timeZone } from "./DirectPublish";

const dayKey = (iso: string) => new Date(iso).toDateString();
function dayLabel(iso: string) {
  const d = new Date(iso),
    today = new Date();
  const diff = Math.round(
    (new Date(d.toDateString()).getTime() -
      new Date(today.toDateString()).getTime()) /
      86400000,
  );
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** Scheduled posts grouped by day (no calendar grid in M5). */
export function ScheduledView({ rows }: { rows: Row[] }) {
  const scheduled = rows
    .filter((r) => r.post.status === "scheduled" && r.post.scheduledAt)
    .sort((a, b) => a.post.scheduledAt!.localeCompare(b.post.scheduledAt!));
  const groups = new Map<string, Row[]>();
  for (const r of scheduled) {
    const k = dayKey(r.post.scheduledAt!);
    groups.set(k, [...(groups.get(k) || []), r]);
  }
  return (
    <div className="scheduled-view">
      <p className="muted small">
        {SCHEDULER_NOTE} Times are in {timeZone()}.
      </p>
      {!scheduled.length && (
        <p className="muted">
          Nothing scheduled. Approve a post, then choose Schedule… in its
          publish sheet.
        </p>
      )}
      {[...groups.values()].map((items) => (
        <section key={dayKey(items[0].post.scheduledAt!)}>
          <h3 className="day-heading">{dayLabel(items[0].post.scheduledAt!)}</h3>
          {items.map((r) => (
            <ScheduledRow key={r.post.id} row={r} />
          ))}
        </section>
      ))}
    </div>
  );
}

function ScheduledRow({ row }: { row: Row }) {
  const { post } = row;
  const overdue = isOverdue(post);
  const [rescheduling, setRescheduling] = useState(false),
    [at, setAt] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = useRefresh();
  const base = `/projects/${row.projectId}/stories/${post.storyId}/posts/${post.id}`;
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      setRescheduling(false);
      refresh();
    } catch (e) {
      message(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="list-toolbar scheduled-row">
      <span className="mono">
        {new Date(post.scheduledAt!).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </span>
      <span>{post.platform === "x" ? "X" : "LinkedIn"}</span>
      <Link
        to="/projects/$projectId/stories/$storyId"
        params={{ projectId: row.projectId, storyId: post.storyId }}
      >
        {row.storyTitle}
      </Link>
      <span className="muted">{row.projectName}</span>
      {overdue && <span className="chip error">Overdue</span>}
      {overdue && (
        <div className="actions">
          <Button
            variant="default"
            disabled={busy}
            onClick={() =>
              void run(
                () =>
                  api(base + "/post-now", "POST", {
                    revisionId: post.currentRevisionId,
                  }),
                "Posting",
              )
            }
          >
            Post now
          </Button>
          <Button disabled={busy} onClick={() => setRescheduling(true)}>
            Reschedule
          </Button>
        </div>
      )}
      {rescheduling && (
        <div className="actions">
          <input
            type="datetime-local"
            aria-label="New time"
            step={1}
            value={at}
            onChange={(e) => setAt(e.target.value)}
          />
          <Button
            variant="default"
            disabled={busy || !at}
            onClick={() =>
              void run(
                () =>
                  api(base + "/schedule", "POST", {
                    revisionId: post.currentRevisionId,
                    scheduledAt: new Date(at).toISOString(),
                  }),
                "Rescheduled",
              )
            }
          >
            Save
          </Button>
        </div>
      )}
    </div>
  );
}
