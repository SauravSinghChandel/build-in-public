import type { AgentStatus, JobView, ProjectRow } from "@bip/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { Button } from "../../components/ui/button";
import { message } from "../../components/workspace";
export function useJobs() {
  return useQuery({
    queryKey: ["jobs"],
    queryFn: () => api<JobView[]>("/jobs"),
    refetchInterval: 3000,
  });
}
export function JobEvents() {
  const q = useQueryClient();
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("job", (event) => {
      const e = JSON.parse((event as MessageEvent).data);
      if (e.type === "progress" && e.message)
        q.setQueryData<Record<string, string>>(["partials"], (old) => ({
          ...old,
          [e.jobId]: e.message,
        }));
      if (e.type === "text")
        q.setQueryData<Record<string, string>>(["partials"], (old) => ({
          ...old,
          [e.jobId]: ((old || {})[e.jobId] || "") + e.text,
        }));
      if (!["text", "progress"].includes(e.type)) {
        void q.invalidateQueries({ queryKey: ["jobs"] });
        if (["succeeded", "failed", "cancelled"].includes(e.type))
          void q.invalidateQueries();
      }
    });
    source.addEventListener("connected", () => void q.invalidateQueries());
    return () => source.close();
  }, [q]);
  return null;
}
export function AgentPicker({
  p,
  task,
  value,
  onChange,
}: {
  p: ProjectRow;
  task: string;
  value: string;
  onChange: (value: "claude" | "codex") => void;
}) {
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<AgentStatus[]>("/agents/status"),
  });
  useEffect(() => {
    const last = p.settings.lastAgent?.[task];
    if (last) onChange(last);
    else if (
      agents.data?.length &&
      !agents.data.find((a) => a.id === value)?.usable
    ) {
      const first = agents.data.find((a) => a.usable);
      if (first) onChange(first.id as "claude" | "codex");
    }
  }, [p.id, task, agents.data]);
  return (
    <div className="agent-picker" role="group" aria-label={`Agent for ${task}`}>
      {["claude", "codex"].map((id) => {
        const agent = agents.data?.find((a) => a.id === id);
        return (
          <button
            type="button"
            key={id}
            disabled={!agent?.usable}
            title={agent?.usable ? id : agent?.hint || "Checking provider…"}
            aria-pressed={value === id}
            onClick={() => onChange(id as "claude" | "codex")}
          >
            {id === "claude" ? "Claude" : "Codex"}
          </button>
        );
      })}
    </div>
  );
}
export function JobFeedback({ job }: { job?: JobView }) {
  const partials = useQuery<Record<string, string>>({
    queryKey: ["partials"],
    queryFn: () => ({}),
    enabled: false,
  });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!job || job.status === "succeeded") return null;
  const active = ["queued", "running"].includes(job.status);
  return (
    <div className="job-feedback" role="status">
      <span>
        {job.status[0].toUpperCase() + job.status.slice(1)}
        {active
          ? ` · ${Math.max(0, Math.floor((now - Date.parse(job.started_at || job.created_at)) / 1000))}s`
          : ""}
      </span>
      {job.error && <p className="error">{job.error}</p>}
      {active && (
        <pre>
          {(
            partials.data?.[job.id] ||
            (job.type === "project.summary"
              ? "Reading repository…"
              : job.type === "story.angles"
                ? "Finding story angles…"
                : "Preparing your draft…")
          ).slice(-4000)}
        </pre>
      )}
      <Button
        onClick={() =>
          void api(
            `/jobs/${job.id}/${active ? "cancel" : "resume"}`,
            "POST",
          ).catch(message)
        }
      >
        {active ? "Cancel" : job.status === "failed" ? "Retry" : "Resume"}
      </Button>
    </div>
  );
}
export function JobsIndicator() {
  const jobs = useJobs();
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<ProjectRow[]>("/projects"),
  });
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>(() =>
    JSON.parse(localStorage.getItem("bip-dismissed-jobs") || "[]"),
  );
  const visible = jobs.data?.filter((j) => !dismissed.includes(j.id)) || [];
  const running = visible.filter((j) =>
    ["running", "queued"].includes(j.status),
  ).length;
  const failed = visible.filter((j) =>
    ["failed", "interrupted"].includes(j.status),
  ).length;
  const label = running
    ? `${running} ${running === 1 ? "job" : "jobs"} running`
    : failed
      ? `${failed} ${failed === 1 ? "job" : "jobs"} failed`
      : "Jobs";
  return (
    <div className="jobs-indicator">
      <button onClick={() => setOpen(!open)} aria-expanded={open}>
        {label}
      </button>
      {open && (
        <div className="jobs-popover" role="dialog" aria-label="Jobs">
          {visible.map((j) => (
            <div key={j.id}>
              <strong>{j.type}</strong>
              <small>
                {" "}
                ·{" "}
                {projects.data?.find((p) => p.id === j.project_id)?.name ||
                  "Project"}{" "}
                · {j.status}
              </small>
              {j.error && <p title={j.error}>{j.error.slice(0, 180)}</p>}
              {["failed", "interrupted", "cancelled"].includes(j.status) && (
                <Button
                  onClick={() =>
                    void api(`/jobs/${j.id}/resume`, "POST").catch(message)
                  }
                >
                  Retry
                </Button>
              )}
              <Button
                onClick={() => {
                  const next = [...dismissed, j.id];
                  setDismissed(next);
                  localStorage.setItem(
                    "bip-dismissed-jobs",
                    JSON.stringify(next),
                  );
                }}
              >
                Dismiss
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
