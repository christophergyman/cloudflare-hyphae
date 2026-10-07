import type { ConnectionStatus } from "@/lib/hub";
import { cn } from "@/lib/utils";

/** The hyphae glyph: one node, radiating filaments. */
export function BrandGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle cx="12" cy="12" r="2.4" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.65">
        <path d="M12 9.4V3.8" />
        <path d="M12 14.6v5.6" />
        <path d="M10 10.7 4.6 7.6" />
        <path d="M14 13.3l5.4 3.1" />
        <path d="M10 13.3l-5.4 3.1" />
        <path d="M14 10.7l5.4-3.1" />
      </g>
    </svg>
  );
}

const STATUS_DOT: Record<ConnectionStatus, string> = {
  idle: "bg-signal-muted",
  connecting: "bg-signal-conflict pulse-dot",
  open: "bg-signal-merge pulse-dot",
  reconnecting: "bg-signal-conflict pulse-dot",
  closed: "bg-signal-error",
};

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  idle: "not connected",
  connecting: "connecting",
  open: "live",
  reconnecting: "reconnecting",
  closed: "disconnected",
};

export function StatusDot({ status }: { status: ConnectionStatus }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <span className={cn("size-2 rounded-full", STATUS_DOT[status])} />
      {STATUS_LABEL[status]}
    </span>
  );
}
