import type { ProjectRow } from "@bip/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api";
import { Button } from "../../components/ui/button";
import { message, useRefresh } from "../../components/workspace";
import { AgentPicker, JobFeedback, useJobs } from "./jobs";
export function Summary({ p }: { p: ProjectRow }) {
  const [agent, setAgent] = useState(
    p.settings.lastAgent?.["project.summary"] || "claude",
  );
  const query = useQuery({
      queryKey: ["summary", p.id],
      queryFn: () =>
        api<{ text: string; stale: boolean }>(`/projects/${p.id}/summary`),
    }),
    jobs = useJobs(),
    refresh = useRefresh();
  const job = jobs.data
    ?.filter((j) => j.project_id === p.id && j.type === "project.summary")
    .at(-1);
  return (
    <section className="summary-panel">
      <h2>Repository summary</h2>
      {query.data?.stale && (
        <p className="error">Summary is from an older commit</p>
      )}
      <pre>
        {query.data?.text ||
          "Generate a read-only overview of this repository."}
      </pre>
      <div className="actions">
        <Button
          disabled={
            p.readOnly || (!!job && ["queued", "running"].includes(job.status))
          }
          onClick={() =>
            void api(`/projects/${p.id}/summary`, "POST", { provider: agent })
              .then(refresh)
              .catch(message)
          }
        >
          Generate summary
        </Button>
        <AgentPicker
          p={p}
          task="project.summary"
          value={agent}
          onChange={setAgent}
        />
      </div>
      <JobFeedback job={job} />
    </section>
  );
}
