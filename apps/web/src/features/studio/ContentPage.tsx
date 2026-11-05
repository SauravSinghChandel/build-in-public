import type { PostView } from "@bip/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../../api";
import { ErrorBox, Loading } from "../../components/workspace";
type Row = PostView & {
  projectId: string;
  projectName: string;
  storyTitle: string;
};
export function ContentPage() {
  const query = useQuery({
    queryKey: ["content"],
    queryFn: () => api<Row[]>("/content"),
  });
  const [project, setProject] = useState(""),
    [platform, setPlatform] = useState(""),
    [status, setStatus] = useState("");
  return (
    <>
      <header>
        <h1>Content</h1>
      </header>
      <div className="page">
        <div className="actions">
          <select
            aria-label="Filter project"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          >
            <option value="">All projects</option>
            {[
              ...new Map(
                query.data?.map((r) => [r.projectId, r.projectName]),
              ).entries(),
            ].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter platform"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
          >
            <option value="">All platforms</option>
            <option value="x">X</option>
            <option value="linkedin">LinkedIn</option>
          </select>
          <select
            aria-label="Filter status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            {["draft", "approved", "published"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        {query.isPending ? (
          <Loading />
        ) : query.error ? (
          <ErrorBox error={query.error} />
        ) : (
          <table className="content-table">
            <thead>
              <tr>
                <th>Story</th>
                <th>Project</th>
                <th>Platform</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {query.data
                ?.filter(
                  (r) =>
                    (!project || r.projectId === project) &&
                    (!platform || r.post.platform === platform) &&
                    (!status || r.post.status === status),
                )
                .map((r) => (
                  <tr key={r.post.id}>
                    <td>
                      <Link
                        to="/projects/$projectId/stories/$storyId"
                        params={{
                          projectId: r.projectId,
                          storyId: r.post.storyId,
                        }}
                      >
                        {r.storyTitle}
                      </Link>
                    </td>
                    <td>{r.projectName}</td>
                    <td>{r.post.platform === "x" ? "X" : "LinkedIn"}</td>
                    <td>
                      <span className="chip">{r.post.status}</span>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
