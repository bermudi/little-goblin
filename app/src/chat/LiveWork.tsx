import { Brain } from "lucide-react";
import type { ReactNode } from "react";

export function LiveWork({
  thought,
  icon,
  label = "Thinking",
}: {
  thought?: string | undefined;
  icon?: ReactNode;
  label?: string;
}) {
  return (
    <span className="live-work-lines">
      {thought !== undefined && (
        <span className="live-thought">
          <Brain size={12} strokeWidth={1.75} className="reasoning-ic" />
          <span>{thought}</span>
        </span>
      )}
      <span className={`live-action${thought !== undefined && !icon ? " indented" : ""}`}>
        {icon}
        <span className="shimmer">{label}</span>
      </span>
    </span>
  );
}
