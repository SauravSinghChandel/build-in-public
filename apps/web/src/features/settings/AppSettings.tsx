import type { AgentStatus, DoctorReport, TrackedDir } from "@bip/shared";
import { useQuery } from "@tanstack/react-query";
import { Check, Monitor, Moon, Plus, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { Path } from "../../components/Path";
import { Button } from "../../components/ui/button";
import {
  ErrorBox,
  Loading,
  message,
  useProjects,
  useRefresh,
} from "../../components/workspace";
type Appearance = "dark" | "light" | "system";
function applyTheme(mode: Appearance) {
  document.documentElement.dataset.theme =
    mode === "system"
      ? matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : mode;
}
export function Theme() {
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
export function AppSettings({ onAdd }: { onAdd: () => void }) {
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
                  <code>
                    <Path value={d.path} />
                  </code>
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
                  <p className="muted">
                    {a.hint
                      .split(/(codex login|claude)/)
                      .map((part, i) =>
                        part === "claude" || part === "codex login" ? (
                          <code key={i}>{part}</code>
                        ) : (
                          part
                        ),
                      )}
                  </p>
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
              <code>
                <Path value={storage.data?.dataPath} />
              </code>
              <h3>Backups</h3>
              {storage.data?.backups.length ? (
                storage.data.backups.map((f) => (
                  <p key={f} className="mono small">
                    <Path value={f} />
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
