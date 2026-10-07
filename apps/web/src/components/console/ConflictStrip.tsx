import { X } from "lucide-react";
import { useNow } from "@/lib/hooks";
import type { ConflictState, HubApi } from "@/lib/hub";
import { cn } from "@/lib/utils";

const WINDOW_MS = 15 * 60 * 1000;

function statusLabel(conflict: ConflictState): string {
  switch (conflict.status) {
    case "open":
      return "agent attempting";
    case "kept-both":
      return "kept both, nothing lost";
    case "resolved":
      return "resolved by agent";
  }
}

/** The conflict story, visible without reading the feed. */
export function ConflictStrip({ hub }: { hub: HubApi }) {
  const now = useNow(5000);
  const recent = hub.conflicts.filter((conflict) => now - conflict.at < WINDOW_MS);
  if (recent.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-card/60 px-4 py-1.5 text-xs">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Conflicts</span>
      {recent.map((conflict) => (
        <span
          key={conflict.path}
          title={conflict.detail}
          className="inline-flex items-center gap-2 rounded-sm border bg-secondary/40 px-2 py-1"
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              conflict.status === "open" ? "bg-signal-conflict pulse-dot" : "bg-signal-muted",
            )}
          />
          <span className="font-mono">{conflict.path}</span>
          <span className="text-muted-foreground">{statusLabel(conflict)}</span>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            aria-label={`Dismiss ${conflict.path}`}
            onClick={() => hub.dismissConflict(conflict.path)}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}
