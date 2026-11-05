import type { JobView, ProjectRow, StoryData } from "@bip/shared";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../../api";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { message, useRefresh } from "../../components/workspace";
import { AgentPicker, JobFeedback, useJobs } from "./jobs";
export function AnglesSheet({
  p,
  commits,
  open,
  onClose,
}: {
  p: ProjectRow;
  commits: string[];
  open: boolean;
  onClose: () => void;
}) {
  const [agent, setAgent] = useState(
    p.settings.lastAgent?.["story.angles"] || "claude",
  );
  const [draftAgent, setDraftAgent] = useState(
    p.settings.lastAgent?.["post.draft"] || "claude",
  );
  const [note, setNote] = useState(""),
    [jobId, setJobId] = useState(""),
    [chosen, setChosen] = useState(-1),
    [own, setOwn] = useState(""),
    [busy, setBusy] = useState(false);
  const jobs = useJobs(),
    refresh = useRefresh(),
    navigate = useNavigate();
  const job = jobs.data?.find((j) => j.id === jobId);
  const angles = job?.result?.angles as
    | {
        title: string;
        hook: string;
        why_interesting: string;
        commits: string[];
      }[]
    | undefined;
  const generate = async () => {
    setBusy(true);
    try {
      const j = await api<JobView>(`/projects/${p.id}/angles`, "POST", {
        provider: agent,
        commits,
        note,
      });
      setJobId(j.id);
      refresh();
    } catch (e) {
      message(e);
    } finally {
      setBusy(false);
    }
  };
  const draft = async () => {
    setBusy(true);
    try {
      const angle = chosen >= 0 ? angles?.[chosen] : undefined;
      const title = angle?.title || own;
      const story = await api<StoryData>(`/projects/${p.id}/stories`, "POST", {
        title,
        brief: angle ? `${angle.hook}\n\n${angle.why_interesting}` : own,
        commits,
        angle: angle ? JSON.stringify(angle) : own,
      });
      await api(`/projects/${p.id}/stories/${story.id}/draft`, "POST", {
        provider: draftAgent,
      });
      refresh();
      onClose();
      void navigate({
        to: "/projects/$projectId/stories/$storyId",
        params: { projectId: p.id, storyId: story.id },
      });
    } catch (e) {
      message(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      sheet
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title="Choose a story angle"
    >
      <div className="angle-sheet">
        <label className="field">
          What would you like to share?
          <textarea
            rows={3}
            onInput={(e) => {
              e.currentTarget.style.height = "auto";
              e.currentTarget.style.height =
                e.currentTarget.scrollHeight + "px";
            }}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="A detail you built, learned, or found surprising"
          />
        </label>
        <div className="actions">
          <Button
            disabled={busy || ["running", "queued"].includes(job?.status || "")}
            onClick={() => void generate()}
          >
            Propose 3 angles
          </Button>
          <AgentPicker
            p={p}
            task="story.angles"
            value={agent}
            onChange={setAgent}
          />
        </div>
        <JobFeedback job={job} />
        {angles?.map((angle, i) => (
          <label className="angle-row" data-selected={chosen === i} key={i}>
            <input
              type="radio"
              name="angle"
              checked={chosen === i}
              onChange={() => setChosen(i)}
            />
            <span>
              <strong>{angle.title}</strong>
              <p>{angle.hook}</p>
              <small className="muted">{angle.why_interesting}</small>
            </span>
          </label>
        ))}
        <label className="angle-row own-angle" data-selected={chosen === -1}>
          <span>
            <input
              type="radio"
              name="angle"
              checked={chosen === -1}
              onChange={() => setChosen(-1)}
            />{" "}
            Write my own angle
          </span>
          <input
            value={own}
            onChange={(e) => {
              setOwn(e.target.value);
              setChosen(-1);
            }}
            placeholder="The one thing this story is about"
          />
        </label>
        <div className="actions">
          <Button
            variant="default"
            disabled={busy || !(chosen >= 0 ? angles?.[chosen] : own.trim())}
            onClick={() => void draft()}
          >
            Draft X and LinkedIn
          </Button>
          <AgentPicker
            p={p}
            task="post.draft"
            value={draftAgent}
            onChange={setDraftAgent}
          />
        </div>
      </div>
    </Dialog>
  );
}
