export interface DemoEvent {
  type: string;
  t: number;
  x: number;
  y: number;
  scrollY?: number;
  url?: string;
}
export interface EventLog {
  viewport: { width: number; height: number };
  duration: number;
  events: DemoEvent[];
  actions: { label: string; t: number; endT?: number }[];
  frames: { t: number }[];
}
export function captureQuality(times: number[], durationMs: number) {
  const sorted = [...times].sort((a, b) => a - b);
  const gaps = [
    sorted[0] || 0,
    ...sorted.slice(1).map((t, i) => t - sorted[i]),
    Math.max(0, durationMs - (sorted.at(-1) || 0)),
  ];
  const effectiveFps = durationMs > 0 ? times.length / (durationMs / 1000) : 0,
    maxGapMs = Math.max(0, ...gaps);
  return {
    effectiveFps,
    maxGapMs,
    choppy: effectiveFps < 12 || maxGapMs > 500,
  };
}
export function speedRamp(events: DemoEvent[]) {
  const segments: { start: number; end: number; rate: number }[] = [];
  let current: (typeof segments)[number] | undefined;
  for (const e of events.filter((e) => e.type === "scroll")) {
    if (!current || e.t - current.end > 0.3) {
      current = { start: e.t, end: e.t, rate: 2 };
      segments.push(current);
    } else current.end = e.t;
  }
  return segments
    .filter((s) => s.end - s.start > 0.1)
    .sort((a, b) => b.end - b.start - (a.end - a.start))[0];
}
export const outputTime = (t: number, r?: ReturnType<typeof speedRamp>) =>
  !r || t <= r.start
    ? t
    : t < r.end
      ? r.start + (t - r.start) / 2
      : t - (r.end - r.start) / 2;
export const sourceTime = (t: number, r?: ReturnType<typeof speedRamp>) =>
  !r || t <= r.start
    ? t
    : t < outputTime(r.end, r)
      ? r.start + (t - r.start) * 2
      : t + (r.end - r.start) / 2;
const clamp = (n: number, a = 0, b = 1) => Math.max(a, Math.min(b, n));
const ease = (n: number) => {
  const x = clamp(n);
  return x * x * x * (x * (x * 6 - 15) + 10);
};
export function zoomState(
  t: number,
  clicks: DemoEvent[],
  width: number,
  height: number,
) {
  let z = 1,
    tx = 0,
    ty = 0;
  for (const c of clicks) {
    const d = t - c.t;
    const w =
      d < 0
        ? ease((d + 0.4) / 0.4)
        : d < 0.35
          ? 1
          : 1 - ease((d - 0.35) / 0.65);
    if (w > 0) {
      z = 1 + 0.6 * w;
      // Interpolate from identity; at full zoom the click is centred in BOTH axes if coverage allows.
      const fullX = clamp(width / 2 - c.x * 1.6, width * (1 - 1.6), 0),
        fullY = clamp(height / 2 - c.y * 1.6, height * (1 - 1.6), 0);
      tx = fullX * w;
      ty = fullY * w;
    }
  }
  return { z, tx, ty };
}
export function diffSize(numstat: string, instruction: string) {
  const rows = numstat.trim().split("\n").filter(Boolean),
    lines = rows.reduce(
      (n, r) =>
        n +
        r
          .split("\t")
          .slice(0, 2)
          .reduce((a, v) => a + (Number(v) || 0), 0),
      0,
    );
  return {
    files: rows.length,
    lines,
    largeChange: instruction.length <= 300 && (rows.length > 3 || lines > 200),
  };
}
