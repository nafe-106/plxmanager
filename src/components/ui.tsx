import { PROVIDERS } from "@/lib/providers";

export function providerMeta(id: string) {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[PROVIDERS.length - 1];
}

export function ProviderBadge({ id }: { id: string }) {
  const p = providerMeta(id);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium text-zinc-200 ring-1 ring-zinc-700/60">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
      {p.label}
    </span>
  );
}

const STATUS_STYLES: Record<string, { label: string; cls: string; dot: string }> = {
  alive: { label: "🟢 Alive", cls: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30", dot: "bg-emerald-400" },
  dead: { label: "🔴 Dead", cls: "bg-red-500/10 text-red-300 ring-red-500/30", dot: "bg-red-400" },
  rate_limited: { label: "🟡 Rate-limited", cls: "bg-amber-500/10 text-amber-300 ring-amber-500/30", dot: "bg-amber-400" },
  unknown: { label: "⚪ Unknown", cls: "bg-zinc-700/20 text-zinc-400 ring-zinc-600/40", dot: "bg-zinc-500" },
  running: { label: "🟢 Running", cls: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30", dot: "bg-emerald-400" },
  queued: { label: "🟡 Queued", cls: "bg-sky-500/10 text-sky-300 ring-sky-500/30", dot: "bg-sky-400" },
  complete: { label: "✅ Complete", cls: "bg-teal-500/10 text-teal-300 ring-teal-500/30", dot: "bg-teal-400" },
  error: { label: "🔴 Error", cls: "bg-red-500/10 text-red-300 ring-red-500/30", dot: "bg-red-400" },
  stopped: { label: "⚫ Stopped", cls: "bg-zinc-700/20 text-zinc-400 ring-zinc-600/40", dot: "bg-zinc-500" },
  offline: { label: "⚪ Unknown", cls: "bg-zinc-700/20 text-zinc-400 ring-zinc-600/40", dot: "bg-zinc-500" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.unknown;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ${s.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

export function PlexusBadge({ status }: { status: string }) {
  if (status === "alive")
    return <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-300 ring-1 ring-emerald-500/30">Tunnel 🟢 Online</span>;
  if (status === "dead")
    return <span className="rounded-md bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-300 ring-1 ring-red-500/30">Tunnel 🔴 Down</span>;
  return <span className="rounded-md bg-zinc-700/20 px-2 py-0.5 text-xs font-medium text-zinc-400 ring-1 ring-zinc-600/40">Tunnel ⚪ Unknown</span>;
}

export function Progress({ pct, color }: { pct: number; color?: string }) {
  const c = color ?? (pct >= 95 ? "bg-red-500" : pct >= 80 ? "bg-amber-400" : "bg-emerald-500");
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
      <div className={`h-full rounded-full ${c}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 ${className}`}>
      {children}
    </div>
  );
}

export function Stat({ label, value, sub, tone = "default" }: { label: string; value: React.ReactNode; sub?: string; tone?: "default" | "red" | "green" | "amber" }) {
  const tones: Record<string, string> = {
    default: "text-zinc-100",
    red: "text-red-400",
    green: "text-emerald-400",
    amber: "text-amber-400",
  };
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <p className="text-xs uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tones[tone]}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-zinc-500">{sub}</p>}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "secondary",
  disabled,
  className = "",
  title,
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  className?: string;
  title?: string;
  type?: "button" | "submit" | "reset";
}) {
  const variants: Record<string, string> = {
    primary: "bg-emerald-600 text-white hover:bg-emerald-500",
    secondary: "bg-zinc-800 text-zinc-200 hover:bg-zinc-700 ring-1 ring-zinc-700/70",
    danger: "bg-red-600/90 text-white hover:bg-red-500",
    ghost: "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200",
  };
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Empty({ text }: { text: string }) {
  return <p className="px-2 py-6 text-center text-sm text-zinc-600">{text}</p>;
}