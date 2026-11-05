import type { AgentStatus } from "@bip/shared";
import { useQuery } from "@tanstack/react-query";
import { Check, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Button } from "../../components/ui/button";
import { ErrorBox, Loading } from "../../components/workspace";
import { AddProjects } from "./AddProjects";

const DONE_KEY = "bip-onboarding-done";
export const DEFAULT_AGENT_KEY = "bip-default-agent";
function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
export const onboardingDone = () => read(DONE_KEY) === "1";
export const finishOnboarding = () => write(DONE_KEY, "1");
type Step = "agents" | "folder" | "repos";
const STEPS: { id: Step; title: string }[] = [
  { id: "agents", title: "Pick your agents" },
  { id: "folder", title: "Add the folder where your projects live" },
  { id: "repos", title: "Pick repositories" },
];
/** First-run checklist shown on Projects while nothing is tracked. Every step is skippable. */
export function Onboarding({ onFinish }: { onFinish: () => void }) {
  const [done, setDone] = useState<Partial<Record<Step, "done" | "skipped">>>(
    {},
  );
  const [dialog, setDialog] = useState<"folder" | "single" | null>(null);
  const [agent, setAgent] = useState(read(DEFAULT_AGENT_KEY) || "");
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<AgentStatus[]>("/agents/status"),
  });
  const usable = agents.data?.filter((a) => a.usable) || [];
  const chosen = usable.some((a) => a.id === agent)
    ? agent
    : usable[0]?.id || "";
  const current = STEPS.find((s) => !done[s.id])?.id;
  const mark = (step: Step, how: "done" | "skipped") => {
    const next = { ...done, [step]: how };
    setDone(next);
    if (STEPS.every((s) => next[s.id])) {
      finishOnboarding();
      onFinish();
    }
  };
  return (
    <div className="onboarding">
      <h2>Set up Build in Public</h2>
      <p className="muted">
        Three quick steps. Skip any of them; you can do each one later from
        Settings or the Projects page.
      </p>
      <ol>
        {STEPS.map((s, i) => {
          const state = done[s.id];
          return (
            <li
              key={s.id}
              className={`onboarding-step${s.id === current ? " current" : ""}`}
              aria-current={s.id === current ? "step" : undefined}
            >
              <h3>
                <span className="step-number" aria-hidden="true">
                  {state ? <Check /> : i + 1}
                </span>
                {s.title}
                {state && (
                  <span className="muted small">
                    {state === "done" ? "Done" : "Skipped"}
                  </span>
                )}
              </h3>
              {!state && s.id === "agents" && (
                <>
                  <p className="muted">
                    Build in Public drafts with the Claude Code or Codex CLI,
                    signed in with your own account. One is enough.
                  </p>
                  {agents.isPending && <Loading />}
                  {agents.error && <ErrorBox error={agents.error} />}
                  {agents.data && (
                    <div
                      className="onboarding-agents"
                      role="radiogroup"
                      aria-label="Default agent"
                    >
                      {agents.data.map((a) => (
                        <label key={a.id} className="onboarding-agent">
                          <input
                            type="radio"
                            name="default-agent"
                            value={a.id}
                            disabled={!a.usable}
                            checked={chosen === a.id}
                            onChange={() => setAgent(a.id)}
                          />
                          <span>
                            <strong>
                              {a.id === "claude" ? "Claude Code" : "Codex"}
                            </strong>
                            <span className="muted small">
                              {a.installed
                                ? `${a.version || "Installed"} · ${a.auth}`
                                : "Not installed"}
                            </span>
                            {!a.usable && a.hint && (
                              <span className="small">{a.hint}</span>
                            )}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                  <div className="actions">
                    {!usable.length && agents.data && (
                      <Button onClick={() => void agents.refetch()}>
                        <RefreshCw />
                        Check again
                      </Button>
                    )}
                    <Button onClick={() => mark("agents", "skipped")}>
                      Skip
                    </Button>
                    <Button
                      variant="default"
                      disabled={!chosen}
                      onClick={() => {
                        write(DEFAULT_AGENT_KEY, chosen);
                        mark("agents", "done");
                      }}
                    >
                      Use {chosen === "codex" ? "Codex" : "Claude Code"}
                    </Button>
                  </div>
                </>
              )}
              {!state && s.id === "folder" && (
                <>
                  <p className="muted">
                    Build in Public finds the Git repositories inside it. You
                    choose which ones to track.
                  </p>
                  <div className="actions">
                    <Button onClick={() => mark("folder", "skipped")}>
                      Skip
                    </Button>
                    <Button variant="default" onClick={() => setDialog("folder")}>
                      <Plus />
                      Add folder
                    </Button>
                  </div>
                </>
              )}
              {!state && s.id === "repos" && (
                <>
                  <p className="muted">
                    After you add a folder, choose the repositories to track.
                    You can also track one repository directly.
                  </p>
                  <div className="actions">
                    <Button onClick={() => mark("repos", "skipped")}>
                      Skip
                    </Button>
                    <Button onClick={() => setDialog("single")}>
                      Add a single repository
                    </Button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ol>
      <AddProjects
        open={dialog !== null}
        initialMode={dialog || "folder"}
        onOpenChange={(open) => !open && setDialog(null)}
        onStage={(stage) => {
          if (stage === "repos" && dialog === "folder" && !done.folder)
            setDone((d) => ({ ...d, folder: "done" }));
        }}
      />
    </div>
  );
}
