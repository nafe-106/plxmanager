export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Format a decimal hour amount as "Xh Ym" (e.g. 6.25 → "6h 15m").
export function formatHours(h: number): string {
  if (!Number.isFinite(h) || h <= 0) return "0m";
  const totalMin = Math.round(h * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  if (hh > 0 && mm > 0) return `${hh}h ${mm}m`;
  if (hh > 0) return `${hh}h`;
  return `${mm}m`;
}