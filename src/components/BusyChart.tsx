"use client";

export default function BusyChart({
  hours,
  labels = true,
  highlight,
}: {
  hours: number[];
  labels?: boolean;
  highlight?: number;
}) {
  const max = Math.max(1, ...hours);
  return (
    <div className="flex items-end gap-[2px]">
      {hours.map((h, i) => {
        const hgt = h === 0 ? 3 : Math.max(6, (h / max) * 100);
        const isBusy = i === highlight;
        return (
          <div key={i} className="flex flex-1 flex-col items-center">
            <div className="flex h-16 w-full items-end">
              <div
                title={`${String(i).padStart(2, "0")}:00 — ${h} hits`}
                className={`w-full rounded-sm transition ${isBusy ? "bg-amber-400" : h > 0 ? "bg-emerald-500/70" : "bg-zinc-800"}`}
                style={{ height: `${hgt}%`, minHeight: 3 }}
              />
            </div>
            {labels && (
              <span className={`mt-1 text-[9px] tabular-nums ${isBusy ? "text-amber-300" : "text-zinc-600"}`}>
                {i % 3 === 0 ? i : "·"}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}