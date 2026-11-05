import type { ProjectRow } from "@bip/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Copy, FolderOpen, GitBranch } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import { Path } from "../components/Path";
import { Button } from "../components/ui/button";
import { Empty, ErrorBox, Loading, message } from "../components/workspace";
import { ProjectSettings } from "../features/project/ProjectSettings";
import { Context } from "../features/project/context/Context";
import { Overview } from "../features/project/overview/Overview";
import { Stories } from "../features/studio/Stories";
export function Workspace({ id }: { id: string }) {
  const {
    data: p,
    error,
    isPending,
  } = useQuery({
    queryKey: ["project", id],
    queryFn: () => api<ProjectRow>(`/projects/${id}`),
  });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const segment = pathname.split("/")[3] || "overview";
  const tab = segment[0].toUpperCase() + segment.slice(1);
  const setTab = (name: string) =>
    void navigate({
      to: (name === "Overview"
        ? `/projects/${id}`
        : `/projects/${id}/${name.toLowerCase()}`) as "/",
    });
  if (isPending)
    return (
      <div className="page">
        <Loading />
      </div>
    );
  if (error) return <ErrorBox error={error} />;
  if (!p) return null;
  return (
    <>
      <header className="workspace-header">
        <div>
          <Link to="/" className="muted small">
            Projects
          </Link>
          <h1>
            {p.name}{" "}
            <span className="chip mono">
              <GitBranch />
              {p.branch}
            </span>
          </h1>
          <p className="mono muted path">
            <Path value={p.path} />
            <Button
              size="icon"
              variant="ghost"
              aria-label="Copy path"
              onClick={() =>
                void navigator.clipboard
                  .writeText(p.path)
                  .then(() => toast.success("Path copied"))
                  .catch(message)
              }
            >
              <Copy />
            </Button>
          </p>
        </div>
        <Button
          onClick={() =>
            void navigator.clipboard
              .writeText(p.path)
              .then(() => toast.success("Path copied"))
              .catch(message)
          }
        >
          <FolderOpen />
          Open folder
        </Button>
      </header>
      <div
        className="tabs workspace-tabs"
        role="tablist"
        aria-label="Project tabs"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          const tabs = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "[role=tab]",
            ),
          ];
          const index = tabs.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : (index +
                    (event.key === "ArrowRight" ? 1 : -1) +
                    tabs.length) %
                  tabs.length;
          event.preventDefault();
          tabs[next].focus();
          tabs[next].click();
        }}
      >
        {["Overview", "Stories", "Media", "Context", "Settings"].map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="page">
        {p.status === "missing" ? (
          <Empty title="Folder not found">
            <p>Locate this project's folder in Settings.</p>
            <ProjectSettings p={p} />
          </Empty>
        ) : tab === "Overview" ? (
          <Overview p={p} onContext={() => setTab("Context")} />
        ) : tab === "Stories" ? (
          <Stories p={p} storyId={pathname.split("/")[4]} />
        ) : tab === "Context" ? (
          <Context p={p} />
        ) : tab === "Settings" ? (
          <ProjectSettings p={p} />
        ) : (
          <Empty
            title={
              tab === "Stories"
                ? "Your next story starts with your work"
                : "A home for your project media"
            }
          >
            <p>
              {tab === "Stories"
                ? "Stories arrive in the next update: you'll turn commits into X and LinkedIn drafts here."
                : "Media tools are coming: capture screenshots and create polished images and demo videos here."}
            </p>
          </Empty>
        )}
      </div>
    </>
  );
}
