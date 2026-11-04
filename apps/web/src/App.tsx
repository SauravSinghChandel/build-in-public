import { useState, useEffect, useRef, Fragment, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import {
  FolderGit2,
  FileText,
  Settings as SettingsIcon,
  Search,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Copy,
  FolderOpen,
  GitBranch,
  ChevronDown,
  ChevronRight,
  Check,
  Sun,
  Moon,
  Monitor,
} from "lucide-react";
import { Toaster, toast } from "sonner";
import type {
  ProjectRow,
  TrackedDir,
  DiscoveredRepo,
  Commit,
  AgentStatus,
  DoctorReport,
} from "@bip/shared";
import { api } from "./api";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { Command } from "./components/ui/command";
import { Switch } from "./components/ui/switch";
import { CommitMenu } from "./components/ui/dropdown-menu";
import { Tooltip } from "./components/ui/tooltip";
function message(error: unknown) {
  toast.error(error instanceof Error ? error.message : String(error));
}
function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => api<ProjectRow[]>("/projects"),
  });
}
function useRefresh() {
  const q = useQueryClient();
  return () => {
    void q.invalidateQueries();
  };
}
function Empty({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <FolderGit2 size={32} />
      <h2>{title}</h2>
      {children}
    </div>
  );
}
function ErrorBox({ error }: { error: unknown }) {
  return (
    <p className="error" role="alert">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}
function Loading() {
  return (
    <div className="loading" role="status">
      Loading workspace…
      <div />
      <div />
      <div />
    </div>
  );
}
function relative(date: string | null) {
  if (!date) return "No commits yet";
  const days = Math.floor((Date.now() - new Date(date).getTime()) / 86400000);
  return days < 1 ? "Today" : days === 1 ? "Yesterday" : `${days} days ago`;
}
function day(date: string) {
  const d = new Date(date);
  if (d.toDateString() === new Date().toDateString()) return "Today";
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return d.toDateString() === yesterday.toDateString()
    ? "Yesterday"
    : d.toLocaleDateString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
      });
}
export default function App() {
  const [collapsed, setCollapsed] = useState(false),
    [add, setAdd] = useState(false),
    [palette, setPalette] = useState(false);
  const { data: projects = [] } = useProjects();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const refresh = useRefresh();
  const rescan = async () => {
    try {
      await api("/projects?rescan=1");
      refresh();
      toast.success("Folders rescanned");
    } catch (e) {
      message(e);
    }
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", k);
    let last = 0;
    const focus = () => {
      if (Date.now() - last > 5000) {
        last = Date.now();
        void api("/projects?rescan=1").then(refresh).catch(message);
      }
    };
    window.addEventListener("focus", focus);
    void api("/projects?rescan=1").then(refresh).catch(message);
    return () => {
      window.removeEventListener("keydown", k);
      window.removeEventListener("focus", focus);
    };
  }, []);
  return (
    <>
      <Theme />
      <div className={`app ${collapsed ? "collapsed" : ""}`}>
        <aside className="rail">
          <Link to="/" className="brand">
            {collapsed ? (
              "BIP"
            ) : (
              <>
                Build in
                <br />
                Public
              </>
            )}
          </Link>
          <Button
            variant="ghost"
            size="icon"
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>
          <nav>
            <Link
              to="/"
              activeOptions={{ exact: true }}
              title="Projects"
              aria-label="Projects"
            >
              <FolderGit2 />
              <span>Projects</span>
            </Link>
            <Link to="/content" title="Content" aria-label="Content">
              <FileText />
              <span>Content</span>
            </Link>
            <Link to="/settings" title="Settings" aria-label="Settings">
              <SettingsIcon />
              <span>Settings</span>
            </Link>
          </nav>
          <Button
            variant="ghost"
            className="search-button"
            title="Search (Ctrl+K)"
            onClick={() => setPalette(true)}
          >
            <Search />
            <span>Search</span>
            <kbd>⌘K</kbd>
          </Button>
        </aside>
        <main>
          {pathname === "/settings" ? (
            <AppSettings onAdd={() => setAdd(true)} />
          ) : pathname === "/content" ? (
            <>
              <header>
                <h1>Content</h1>
              </header>
              <Empty title="Your stories will live here">
                <p>
                  Stories arrive in the next update: turn commits into X and
                  LinkedIn drafts.
                </p>
              </Empty>
            </>
          ) : pathname.startsWith("/projects/") ? (
            <Workspace key={pathname} id={pathname.split("/")[2]} />
          ) : (
            <ProjectsPage onAdd={() => setAdd(true)} onRescan={rescan} />
          )}
        </main>
      </div>
      <AddProjects open={add} onOpenChange={setAdd} />
      <Dialog open={palette} onOpenChange={setPalette} title="Search workspace">
        <Command>
          <Command.Input autoFocus placeholder="Jump to a project or action…" />
          <Command.List>
            <Command.Empty>No results found.</Command.Empty>
            <Command.Group heading="Actions">
              <Command.Item
                onSelect={() => {
                  setPalette(false);
                  setAdd(true);
                }}
              >
                Add folder
              </Command.Item>
              <Command.Item
                onSelect={() => {
                  setPalette(false);
                  void rescan();
                }}
              >
                Rescan folders
              </Command.Item>
              <Command.Item disabled>
                New story · Coming in the next update
              </Command.Item>
            </Command.Group>
            <Command.Group heading="Projects">
              {projects.map((p) => (
                <Command.Item
                  key={p.id}
                  onSelect={() => {
                    setPalette(false);
                    void navigate({
                      to: "/projects/$projectId",
                      params: { projectId: p.id },
                    });
                  }}
                >
                  {p.name}
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>
        </Command>
      </Dialog>
      <Toaster
        position="bottom-right"
        theme="system"
        toastOptions={{
          style: {
            background: "var(--surface)",
            color: "var(--text)",
            border: "1px solid var(--line)",
          },
        }}
      />
    </>
  );
}
function ProjectsPage({
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
                        <p className="mono muted">{p.path}</p>
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
                          {p.path.replace(/^\/home\/[^/]+/, "~")}
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
                      <span className="muted">No posts yet</span>
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
function AddProjects({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [path, setPath] = useState(""),
    [depth, setDepth] = useState(2),
    [mode, setMode] = useState("folder"),
    [repos, setRepos] = useState<DiscoveredRepo[] | null>(null),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const refresh = useRefresh();
  const dirs = useQuery({
    queryKey: ["dirs", path],
    queryFn: () => api<string[]>(`/fs/dirs?prefix=${encodeURIComponent(path)}`),
    enabled: open && path.length > 0,
  });
  useEffect(() => {
    if (open) {
      setRepos(null);
      setError(null);
      setSelected(new Set());
    }
  }, [open]);
  async function scan(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<DiscoveredRepo[]>("/scan", "POST", {
        root: path,
        depth: mode === "single" ? 1 : depth,
      });
      if (mode === "single" && !result.some((r) => r.path === path))
        throw Error("Choose a repository root");
      setRepos(
        mode === "single" ? result.filter((r) => r.path === path) : result,
      );
      setSelected(new Set());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function track() {
    setBusy(true);
    try {
      if (mode === "folder")
        await api("/tracked-dirs", "POST", { root: path, depth });
      await api("/projects", "POST", { paths: [...selected] });
      refresh();
      toast.success(`Tracking ${selected.size} projects`);
      onOpenChange(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const toggle = (p: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add projects"
      description={
        repos
          ? "Choose the repositories you want to track."
          : "Choose a folder to find your Git repositories."
      }
    >
      {error != null && <ErrorBox error={error} />}{" "}
      {!repos ? (
        <>
          <div className="tabs">
            <button
              className={mode === "folder" ? "active" : ""}
              onClick={() => setMode("folder")}
            >
              Choose a folder
            </button>
            <button
              className={mode === "single" ? "active" : ""}
              onClick={() => setMode("single")}
            >
              Add a single repository
            </button>
          </div>
          <form onSubmit={(e) => void scan(e)}>
            <label className="field">
              {mode === "folder" ? "Folder path" : "Repository path"}
              <input
                className="mono"
                list="directories"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="~/projects"
                required
              />
              <datalist id="directories">
                {dirs.data?.map((p) => (
                  <option value={p} key={p} />
                ))}
              </datalist>
            </label>
            {mode === "folder" && (
              <label className="field">
                Scan depth
                <select
                  value={depth}
                  onChange={(e) => setDepth(Number(e.target.value))}
                >
                  {[1, 2, 3].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
            )}
            <div className="dialog-footer">
              <Button type="button" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button variant="default" disabled={busy}>
                {busy ? "Finding…" : "Find repositories"}
              </Button>
            </div>
          </form>
        </>
      ) : (
        <>
          <div className="list-toolbar">
            <span>{repos.length} repositories found</span>
            <label>
              <input
                type="checkbox"
                aria-label="Select all"
                checked={
                  repos.some((r) => !r.tracked) &&
                  repos
                    .filter((r) => !r.tracked)
                    .every((r) => selected.has(r.path))
                }
                onChange={(e) =>
                  setSelected(
                    new Set(
                      e.target.checked
                        ? repos.filter((r) => !r.tracked).map((r) => r.path)
                        : [],
                    ),
                  )
                }
              />{" "}
              Select all
            </label>
          </div>
          <div className="repo-picker">
            {repos.map((r) => (
              <label className="repo-choice" key={r.path}>
                <input
                  type="checkbox"
                  checked={r.tracked || selected.has(r.path)}
                  disabled={r.tracked}
                  onChange={() => toggle(r.path)}
                />
                <span>
                  <strong>{r.name}</strong>
                  <span className="mono muted">{r.path}</span>
                </span>
                <span className="mono muted">{r.branch}</span>
                <span className="muted">
                  {r.tracked ? "Tracking" : relative(r.lastCommitAt)}
                </span>
              </label>
            ))}
          </div>
          <div className="dialog-footer">
            <Button onClick={() => setRepos(null)}>Back</Button>
            <Button
              variant="default"
              disabled={!selected.size || busy}
              onClick={() => void track()}
            >
              Track {selected.size} projects
            </Button>
          </div>
          <p className="muted small">
            Project data stays in .bip/. Back it up before using git clean -fdx
            or deleting a repository.
          </p>
        </>
      )}
    </Dialog>
  );
}
function Workspace({ id }: { id: string }) {
  const {
    data: p,
    error,
    isPending,
  } = useQuery({
    queryKey: ["project", id],
    queryFn: () => api<ProjectRow>(`/projects/${id}`),
  });
  const [tab, setTab] = useState("Overview");
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
            {p.path}
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
function Overview({ p, onContext }: { p: ProjectRow; onContext: () => void }) {
  const [limit, setLimit] = useState(50);
  const {
    data: commits,
    isPending,
    error,
  } = useQuery({
    queryKey: ["commits", p.id, limit],
    queryFn: async () => {
      const pages: Commit[] = [];
      for (let offset = 0; offset < limit; offset += 50)
        pages.push(
          ...(await api<Commit[]>(
            `/projects/${p.id}/commits?offset=${offset}&limit=50`,
          )),
        );
      return pages;
    },
  });
  const context = useQuery({
    queryKey: ["context", p.id],
    queryFn: () =>
      api<{ shareable: string; private: string }>(`/projects/${p.id}/context`),
  });
  const [selected, setSelected] = useState<Set<string>>(new Set()),
    [expanded, setExpanded] = useState<Set<string>>(new Set());
  const anchor = useRef(0);
  const refresh = useRefresh();
  let previous = "";
  function select(index: number, shift: boolean) {
    const sha = commits![index].sha;
    setSelected((old) => {
      const next = new Set(old);
      const value = !next.has(sha);
      for (
        let n = shift ? Math.min(anchor.current, index) : index;
        n <= (shift ? Math.max(anchor.current, index) : index);
        n++
      ) {
        if (value) next.add(commits![n].sha);
        else next.delete(commits![n].sha);
      }
      return next;
    });
    anchor.current = index;
  }
  return (
    <div className="overview">
      <section aria-label="Commit timeline">
        {p.markerLost && (
          <p className="error">
            The last shared commit changed. Showing activity after its saved
            date.
          </p>
        )}
        <div className="section-heading">
          <h2>Unshared work</h2>
          <span className="signal">{p.unsharedCount} commits</span>
        </div>
        {!p.lastSharedCommit && (
          <p className="muted intro">
            Nothing shared yet. Everything below is new.
          </p>
        )}
        {isPending ? (
          <Loading />
        ) : error ? (
          <ErrorBox error={error} />
        ) : !commits?.length ? (
          <Empty title="No commits yet">
            <p>Your work will appear here after your first commit.</p>
          </Empty>
        ) : (
          <div className="timeline">
            {commits.map((c, i) => {
              const label = day(c.date);
              const newDay = label !== previous;
              previous = label;
              const unshared = i < p.unsharedCount;
              return (
                <Fragment key={c.sha}>
                  {newDay && <h3 className="day-heading">{label}</h3>}
                  {(c.sha === p.lastSharedCommit ||
                    (p.markerLost && i === p.unsharedCount)) && (
                    <div className="shared-marker">
                      Last shared · {day(p.lastSharedDate || c.date)}
                    </div>
                  )}
                  <article
                    className={`commit ${unshared ? "unshared" : ""} ${selected.has(c.sha) ? "selected" : ""}`}
                  >
                    <div className="commit-main">
                      <input
                        aria-label={`Select ${c.subject}`}
                        type="checkbox"
                        checked={selected.has(c.sha)}
                        onChange={() => {}}
                        onClick={(e) => select(i, e.shiftKey)}
                      />
                      <button
                        className="commit-subject"
                        aria-expanded={expanded.has(c.sha)}
                        onClick={() =>
                          setExpanded((s) => {
                            const n = new Set(s);
                            n.has(c.sha) ? n.delete(c.sha) : n.add(c.sha);
                            return n;
                          })
                        }
                      >
                        {expanded.has(c.sha) ? (
                          <ChevronDown />
                        ) : (
                          <ChevronRight />
                        )}
                        <span>
                          <span>{c.subject}</span>
                          <span className="commit-meta">
                            <code>{c.sha.slice(0, 7)}</code>
                            <span>
                              {c.authorEmail !== p.currentUserEmail
                                ? c.authorName
                                : ""}
                            </span>
                            <span>
                              +{c.insertions} −{c.deletions}
                            </span>
                            <span>{c.files.length} files</span>
                          </span>
                        </span>
                      </button>
                      <CommitMenu
                        onMark={() =>
                          void api(`/projects/${p.id}/mark-shared`, "POST", {
                            sha: c.sha,
                          })
                            .then(() => {
                              refresh();
                              toast.success("Shared marker updated");
                            })
                            .catch(message)
                        }
                      />
                    </div>
                    {expanded.has(c.sha) && (
                      <div className="commit-detail">
                        {c.body && <pre>{c.body}</pre>}
                        <ul>
                          {c.files.map((f) => (
                            <li className="mono" key={f.path}>
                              {f.path}{" "}
                              <span className="muted">
                                +{f.insertions} −{f.deletions}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </article>
                </Fragment>
              );
            })}
            {commits.length >= limit && (
              <Button className="older" onClick={() => setLimit((l) => l + 50)}>
                Show older
              </Button>
            )}
          </div>
        )}
        {selected.size > 0 && (
          <div className="selection-bar">
            <span>{selected.size} selected</span>
            <Button onClick={() => setSelected(new Set())}>Clear</Button>
            <Tooltip text="Coming in the next update">
              <span tabIndex={0}>
                <Button variant="default" disabled>
                  Create story from {selected.size}{" "}
                  {selected.size === 1 ? "commit" : "commits"}
                </Button>
              </span>
            </Tooltip>
          </div>
        )}
      </section>
      <aside className="project-sidebar">
        <section>
          <h2>About this project</h2>
          <p>
            {context.data?.shareable
              .replace(/^#.*\n/, "")
              .trim()
              .slice(0, 240) ||
              "Add shareable notes so your stories have the right context."}
          </p>
          <Button variant="ghost" onClick={onContext}>
            Edit context
          </Button>
        </section>
        <section>
          <h2>Active stories</h2>
          <p>No active stories yet.</p>
        </section>
        <section>
          <h2>Last post</h2>
          <p>Nothing published yet.</p>
        </section>
      </aside>
    </div>
  );
}
function Context({ p }: { p: ProjectRow }) {
  const query = useQuery({
    queryKey: ["context", p.id],
    queryFn: () =>
      api<{ shareable: string; private: string }>(`/projects/${p.id}/context`),
  });
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorBox error={query.error} />;
  return query.data ? (
    <ContextEditors key={p.id} p={p} initial={query.data} />
  ) : null;
}
function ContextEditors({
  p,
  initial,
}: {
  p: ProjectRow;
  initial: { shareable: string; private: string };
}) {
  const [notes, setNotes] = useState(initial),
    [status, setStatus] = useState("Saved");
  const latest = useRef(notes);
  const saved = useRef(JSON.stringify(initial));
  const chain = useRef(Promise.resolve());
  const queryClient = useQueryClient();
  const refresh = useRefresh();
  const save = (value: typeof notes) => {
    const serialized = JSON.stringify(value);
    if (serialized === saved.current) return;
    setStatus("Saving…");
    chain.current = chain.current
      .catch(() => {})
      .then(async () => {
        try {
          await api(`/projects/${p.id}/context`, "PUT", value);
          saved.current = serialized;
          queryClient.setQueryData(["context", p.id], value);
          void queryClient.invalidateQueries({ queryKey: ["project", p.id] });
          if (JSON.stringify(latest.current) === serialized) setStatus("Saved");
        } catch (e) {
          setStatus("Could not save");
          message(e);
        }
      });
  };
  useEffect(() => {
    latest.current = notes;
    if (JSON.stringify(notes) === saved.current) {
      setStatus("Saved");
      return;
    }
    setStatus("Unsaved");
    const timer = setTimeout(() => save(notes), 800);
    return () => clearTimeout(timer);
  }, [notes]);
  useEffect(() => {
    return () => {
      save(latest.current);
    };
  }, []);
  return (
    <>
      <div className="section-heading">
        <h2>Project context</h2>
        <span role="status" className="muted small">
          {p.readOnly ? "Read-only: another instance holds the lock" : status}
        </span>
      </div>
      <div className="editors">
        <label className="field">
          Shareable notes<span className="muted small mono">context.md</span>
          <textarea
            disabled={p.readOnly}
            aria-label="Shareable notes"
            value={notes.shareable}
            onChange={(e) => setNotes({ ...notes, shareable: e.target.value })}
          />
        </label>
        <label className="field">
          Private notes
          <span className="muted small">
            Never included in posts. Agents use it only to know what to avoid.
          </span>
          <textarea
            disabled={p.readOnly}
            aria-label="Private notes"
            value={notes.private}
            onChange={(e) => setNotes({ ...notes, private: e.target.value })}
          />
        </label>
      </div>
      <div className="context-options">
        <div className="switch-row">
          <Switch
            id="commit-context"
            checked={p.commitContext}
            disabled={p.readOnly}
            onCheckedChange={(enabled) =>
              void api(`/projects/${p.id}/commit-context`, "POST", { enabled })
                .then(refresh)
                .catch(message)
            }
          />
          <div>
            <label htmlFor="commit-context">
              Commit context.md to this repository
            </label>
            <p className="muted small">
              Only context.md and .bip/.gitignore become visible to Git. Private
              notes stay ignored. Shared worktree exclude rules may affect other
              checkouts.
            </p>
          </div>
        </div>
        <div className="list-toolbar">
          <span className="muted mono">
            .bip/ · {(p.bipSize / 1024).toFixed(1)} KB
          </span>
          <Button
            onClick={() =>
              void api(`/projects/${p.id}/backup`, "POST")
                .then(() => toast.success("Backup saved"))
                .catch(message)
            }
          >
            Back up now
          </Button>
        </div>
        <p className="muted small">
          Deleting the repository or running git clean -fdx removes .bip/. Keep
          a backup of your notes.
        </p>
      </div>
    </>
  );
}
function Locate({
  project,
  onClose,
}: {
  project: ProjectRow | null;
  onClose: () => void;
}) {
  const [path, setPath] = useState("");
  const refresh = useRefresh();
  return (
    <Dialog
      open={!!project}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Locate folder"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (project)
            void api(`/projects/${project.id}/locate`, "POST", { path })
              .then(() => {
                refresh();
                onClose();
              })
              .catch(message);
        }}
      >
        <label className="field">
          Repository path
          <input
            required
            className="mono"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
        </label>
        <div className="dialog-footer">
          <Button variant="default">Locate folder</Button>
        </div>
      </form>
    </Dialog>
  );
}
function ProjectSettings({ p }: { p: ProjectRow }) {
  const [name, setName] = useState(p.name),
    [locate, setLocate] = useState(false),
    [remove, setRemove] = useState<"untrack" | "delete" | null>(null),
    [confirmName, setConfirmName] = useState("");
  const refresh = useRefresh();
  const navigate = useNavigate();
  return (
    <div className="settings-content">
      <h2>Project settings</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void api(`/projects/${p.id}`, "PATCH", { name })
            .then(() => {
              refresh();
              toast.success("Project updated");
            })
            .catch(message);
        }}
      >
        <label className="field">
          Display name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <Button>Save name</Button>
      </form>
      <section>
        <h2>Scan options</h2>
        <p className="muted">Scan depth is managed in Settings → Folders.</p>
        <p className="mono muted">{p.path}</p>
        <Button onClick={() => setLocate(true)}>Locate folder</Button>
      </section>
      <section className="danger-zone">
        <h2>Project data</h2>
        <p className="muted">
          Stop tracking leaves .bip/ in the repository. Deleting data removes
          its notes and metadata.
        </p>
        <div className="actions">
          <Button onClick={() => setRemove("untrack")}>Stop tracking</Button>
          <Button variant="destructive" onClick={() => setRemove("delete")}>
            Delete Build in Public data
          </Button>
        </div>
      </section>
      <Locate project={locate ? p : null} onClose={() => setLocate(false)} />
      <Dialog
        open={!!remove}
        onOpenChange={(o) => {
          if (!o) setRemove(null);
        }}
        title={
          remove === "delete"
            ? "Delete Build in Public data"
            : "Stop tracking this project"
        }
      >
        <p>
          {remove === "delete"
            ? "This permanently removes the .bip folder. Type the project name to confirm."
            : "Your .bip folder and notes will stay in the repository."}
        </p>
        {remove === "delete" && (
          <label className="field">
            Project name
            <input
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={p.name}
            />
          </label>
        )}
        <div className="dialog-footer">
          <Button onClick={() => setRemove(null)}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={remove === "delete" && confirmName !== p.name}
            onClick={() =>
              void api(
                `/projects/${p.id}/${remove === "delete" ? "bip-data" : "untrack"}`,
                remove === "delete" ? "DELETE" : "POST",
                remove === "delete" ? { confirmName } : undefined,
              )
                .then(() => {
                  refresh();
                  void navigate({ to: "/" });
                })
                .catch(message)
            }
          >
            {remove === "delete" ? "Delete data" : "Stop tracking"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
type Appearance = "dark" | "light" | "system";
function applyTheme(mode: Appearance) {
  document.documentElement.dataset.theme =
    mode === "system"
      ? matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : mode;
}
function Theme() {
  useEffect(() => {
    const mode =
      (localStorage.getItem("bip-appearance") as Appearance) || "dark";
    applyTheme(mode);
    const media = matchMedia("(prefers-color-scheme: light)");
    const listener = () =>
      applyTheme(
        (localStorage.getItem("bip-appearance") as Appearance) || "dark",
      );
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);
  return null;
}
function AppSettings({ onAdd }: { onAdd: () => void }) {
  const [section, setSection] = useState("Folders"),
    [mode, setMode] = useState<Appearance>(
      (localStorage.getItem("bip-appearance") as Appearance) || "dark",
    );
  const refresh = useRefresh();
  const dirs = useQuery({
    queryKey: ["tracked-dirs"],
    queryFn: () => api<TrackedDir[]>("/tracked-dirs"),
  });
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<AgentStatus[]>("/agents/status"),
    enabled: section === "Agents",
  });
  const storage = useQuery({
    queryKey: ["doctor"],
    queryFn: () => api<DoctorReport>("/doctor"),
    enabled: section === "Storage",
  });
  return (
    <>
      <header>
        <h1>Settings</h1>
      </header>
      <div className="page app-settings">
        <nav className="settings-nav" aria-label="Settings sections">
          {["Folders", "Agents", "Appearance", "Storage", "About"].map((t) => (
            <button
              key={t}
              className={section === t ? "active" : ""}
              onClick={() => setSection(t)}
            >
              {t}
            </button>
          ))}
        </nav>
        <section className="settings-content">
          <h2>{section}</h2>
          {section === "Folders" ? (
            <>
              <p className="muted">
                Choose where Build in Public looks for your repositories.
              </p>
              {dirs.error && <ErrorBox error={dirs.error} />}{" "}
              {dirs.data?.map((d) => (
                <div className="folder-row" key={d.id}>
                  <code>{d.path}</code>
                  <label>
                    Depth{" "}
                    <select
                      aria-label={`Scan depth for ${d.path}`}
                      value={d.depth}
                      onChange={(e) =>
                        void api("/tracked-dirs", "POST", {
                          root: d.path,
                          depth: Number(e.target.value),
                        })
                          .then(refresh)
                          .catch(message)
                      }
                    >
                      {[1, 2, 3].map((n) => (
                        <option key={n}>{n}</option>
                      ))}
                    </select>
                  </label>
                  <Button
                    onClick={() =>
                      void api("/tracked-dirs", "DELETE", { id: d.id })
                        .then(refresh)
                        .catch(message)
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <Button onClick={onAdd}>
                <Plus />
                Add folder
              </Button>
            </>
          ) : section === "Agents" ? (
            <>
              {agents.isPending && <Loading />}
              {agents.error && <ErrorBox error={agents.error} />}{" "}
              {agents.data?.map((a) => (
                <section className="agent-row" key={a.id}>
                  <h3>{a.id}</h3>
                  <p>
                    {a.installed ? a.version : "Not installed"} · {a.auth}
                  </p>
                  <p className="muted">{a.hint}</p>
                </section>
              ))}
            </>
          ) : section === "Appearance" ? (
            <>
              <p className="muted">Choose how your workspace looks.</p>
              <div
                className="theme-choices"
                role="group"
                aria-label="Appearance"
              >
                {(
                  [
                    ["dark", Moon],
                    ["light", Sun],
                    ["system", Monitor],
                  ] as const
                ).map(([m, Icon]) => (
                  <Button
                    key={m}
                    aria-pressed={mode === m}
                    onClick={() => {
                      setMode(m);
                      localStorage.setItem("bip-appearance", m);
                      applyTheme(m);
                    }}
                  >
                    <Icon />
                    {m[0].toUpperCase() + m.slice(1)}
                    {mode === m && <Check />}
                  </Button>
                ))}
              </div>
            </>
          ) : section === "Storage" ? (
            <>
              {storage.isPending && <Loading />}
              {storage.error && <ErrorBox error={storage.error} />}
              <p className="muted">App data</p>
              <code>{storage.data?.dataPath}</code>
              <h3>Backups</h3>
              {storage.data?.backups.length ? (
                storage.data.backups.map((f) => (
                  <p key={f} className="mono small">
                    {f}
                  </p>
                ))
              ) : (
                <p className="muted">
                  No backups yet. Back up a project from its Context tab.
                </p>
              )}
              <h3>Project storage</h3>
              <StorageRows />
            </>
          ) : (
            <>
              <p>Build in Public · 0.1.0</p>
              <p className="muted">
                A local workspace for the work you haven't shared yet.
              </p>
              <a
                href="https://opensource.org/license/mit"
                target="_blank"
                rel="noreferrer"
              >
                MIT license
              </a>
              <p className="muted small">
                Built with React, Hono, SQLite, Tailwind CSS, Radix UI and
                TanStack.
              </p>
            </>
          )}
        </section>
      </div>
    </>
  );
}
function StorageRows() {
  const { data = [] } = useProjects();
  return (
    <>
      {data.map((p) => (
        <div className="list-toolbar" key={p.id}>
          <span>{p.name}</span>
          <span className="mono muted">{(p.bipSize / 1024).toFixed(1)} KB</span>
        </div>
      ))}
    </>
  );
}
