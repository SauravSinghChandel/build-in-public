import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
export function Path({ value }: { value?: string }) {
  const q = useQuery({
    queryKey: ["fs-home"],
    queryFn: () => api<{ home: string }>("/fs/home"),
    staleTime: Infinity,
  });
  const home = q.data?.home;
  const shown =
    value && home && (value === home || value.startsWith(home + "/"))
      ? "~" + value.slice(home.length)
      : value;
  return <span title={value}>{shown}</span>;
}
