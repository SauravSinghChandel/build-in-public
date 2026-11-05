import type { ProjectRow } from "@bip/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderGit2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";

export function message(error: unknown) {
  toast.error(error instanceof Error ? error.message : String(error));
}
export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => api<ProjectRow[]>("/projects"),
  });
}
export function useRefresh() {
  const q = useQueryClient();
  return () => {
    void q.invalidateQueries();
  };
}
export function Empty({
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
export function ErrorBox({ error }: { error: unknown }) {
  return (
    <p className="error" role="alert">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      Loading workspace…
      <div />
      <div />
      <div />
    </div>
  );
}
export function relative(date: string | null) {
  if (!date) return "No commits yet";
  const days = Math.floor((Date.now() - new Date(date).getTime()) / 86400000);
  return days < 1 ? "Today" : days === 1 ? "Yesterday" : `${days} days ago`;
}
export function day(date: string) {
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
