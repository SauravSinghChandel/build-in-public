import type { ProjectRow } from "@bip/shared";
import { Link } from "@tanstack/react-router";
import { GitBranch, Plus, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { Path } from "../../components/Path";
import { Button } from "../../components/ui/button";
import {
  Empty,
  ErrorBox,
  Loading,
  message,
  relative,
  useProjects,
  useRefresh,
} from "../../components/workspace";
import { Locate } from "../../features/projects/Locate";
import {
  finishOnboarding,
  Onboarding,
  onboardingDone,
} from "../../features/projects/Onboarding";
export function ProjectsPage({
  onAdd,
  onRescan,
}: {
  onAdd: () => void;
  onRescan: () => void;
}) {
  const { data, isPending, error } = useProjects();
  const [sort, setSort] = useState("unshared");
  const refresh = useRefresh();
  const [locate, setLocate] = useState<ProjectRow | null>(null);
  const [onboarding, setOnboarding] = useState(() => !onboardingDone());
  useEffect(() => {
    // Once anything is tracked, first-run onboarding never comes back.
    if (data?.length) {
      finishOnboarding();
      setOnboarding(false);
    }
  }, [data?.length]);
  const sorted = [...(data || [])].sort((a, b) =>
    sort === "name"
      ? a.name.localeCompare(b.name)
      : sort === "recent"
        ? (b.lastCommitAt || "").localeCompare(a.lastCommitAt || "")
        : b.unsharedCount - a.unsharedCount,
  );
  return (
    <>
      <header>
        <h1>Projects</h1>
        <div className="actions">
          <Button onClick={onRescan}>
            <RefreshCw />
            Rescan
          </Button>
          <Button variant="default" onClick={onAdd}>
            <Plus />
            Add projects
          </Button>
        </div>
      </header>
      <div className="page">
        {isPending ? (
          <Loading />
        ) : error ? (
          <ErrorBox error={error} />
        ) : !data?.length && onboarding ? (
          <Onboarding onFinish={() => setOnboarding(false)} />
        ) : !data?.length ? (
          <Empty title="Add the folder where your projects live">
            <p>
              Build in Public finds the Git repositories inside it.
              <br />
              You choose which ones to track.
            </p>
            <Button variant="default" onClick={onAdd}>
              <Plus />
              Add folder
            </Button>
          </Empty>
        ) : (
          <>
            <div className="list-toolbar">
              <span className="muted">{data.length} projects</span>
              <label>
                Sort by{" "}
                <select
                  aria-label="Sort projects"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="unshared">Most unshared work</option>
                  <option value="name">Name</option>
                  <option value="recent">Recent activity</option>
                </select>
              </label>
            </div>
            <div className="project-list">
              {sorted.map((p) => (
                <div
                  className={`project-row ${p.status === "missing" ? "missing" : ""}`}
                  key={p.id}
                  data-testid="project-row"
                >
                  {p.status === "missing" ? (
                    <>
                      <div>
                        <strong>{p.name}</strong>
                        <p className="mono muted">
                          <Path value={p.path} />
                        </p>
                      </div>
                      <span className="error">Folder not found</span>
                      <div className="actions">
                        <Button onClick={() => setLocate(p)}>Locate…</Button>
                        <Button
                          onClick={() =>
                            void api(`/projects/${p.id}/untrack`, "POST")
                              .then(refresh)
                              .catch(message)
                          }
                        >
                          Stop tracking
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <Link
                        className="project-name"
                        to="/projects/$projectId"
                        params={{ projectId: p.id }}
                      >
                        <strong>{p.name}</strong>
                        <span className="mono muted">
                          <Path value={p.path} />
                        </span>
                      </Link>
                      <span className="chip mono">
                        <GitBranch />
                        {p.branch}
                      </span>
                      <span className={p.unsharedCount ? "signal" : "muted"}>
                        {p.unsharedCount
                          ? `● ${p.unsharedCount} unshared`
                          : "Up to date"}
                      </span>
                      <span className="muted" title={p.lastPostAt || undefined}>
                        {p.lastPostAt
                          ? `Last post ${relative(p.lastPostAt)}`
                          : "No posts yet"}
                      </span>
                    </>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      <Locate project={locate} onClose={() => setLocate(null)} />
    </>
  );
}
