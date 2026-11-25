import { useEffect, useRef } from "react";

function elapsed(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function WorkHeader({
  startedAt,
  durationMs = 0,
  now = Date.now,
}: {
  startedAt?: number;
  durationMs?: number;
  now?: () => number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (startedAt === undefined) return;
    const tick = () => {
      if (ref.current !== null) ref.current.textContent = elapsed(now() - startedAt);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt, now]);
  const live = startedAt !== undefined;
  return (
    <div className="work-header">
      {live ? "Working for " : "Worked for "}
      <span ref={ref}>{elapsed(live ? now() - startedAt : durationMs)}</span>
    </div>
  );
}
