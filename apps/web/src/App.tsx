import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  FileText,
  FolderGit2,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings as SettingsIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Toaster, toast } from "sonner";
import { api } from "./api";
import { Button } from "./components/ui/button";
import { Command } from "./components/ui/command";
import { Dialog } from "./components/ui/dialog";
import { message, useProjects, useRefresh } from "./components/workspace";
import { AddProjects } from "./features/projects/AddProjects";
import { ProjectsPage } from "./features/projects/ProjectsPage";
import { AppSettings, Theme } from "./features/settings/AppSettings";
import { ContentPage } from "./features/studio/ContentPage";
import { JobEvents, JobsIndicator } from "./features/studio/jobs";
import { Workspace } from "./routes/Workspace";
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
      <JobEvents />
      <div className={`app ${collapsed ? "collapsed" : ""}`}>
        <aside className="rail">
          <Link to="/" className="brand">
            {collapsed ? "BIP" : "Build in Public"}
          </Link>
          <Button
            variant="ghost"
            size="icon"
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>
          <JobsIndicator />
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
            <ContentPage />
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
              <Command.Item
                onSelect={() => {
                  setPalette(false);
                  if (projects[0])
                    void navigate({
                      to: "/projects/$projectId/stories",
                      params: { projectId: projects[0].id },
                    });
                }}
              >
                New story
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
