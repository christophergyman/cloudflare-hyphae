import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatClock, formatRelative } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import type { FeedEvent } from "@/lib/hub";
import { KIND_LABEL, SIGNAL_BORDER, SIGNAL_DOT, SIGNAL_TEXT } from "@/lib/signals";
import { cn } from "@/lib/utils";

const FILTERS = ["all", "files", "merges", "conflicts", "agent"] as const;
type Filter = (typeof FILTERS)[number];

const FILTER_LABEL: Record<Filter, string> = {
  all: "All",
  files: "Files",
  merges: "Merges",
  conflicts: "Conflicts",
  agent: "Agent",
};

function matches(filter: Filter, event: FeedEvent): boolean {
  switch (filter) {
    case "all":
      return true;
    case "files":
      return event.kind === "change" || event.kind === "delete";
    case "merges":
      return event.kind === "merge";
    case "conflicts":
      return event.kind === "conflict";
    case "agent":
      return event.by === "merging-agent" || event.kind === "resolved";
  }
}

/** Newest first, filterable, each row wearing its signal color. */
export function FeedPanel({ events }: { events: FeedEvent[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const now = useNow(5000);
  void now;
  const filtered = events.filter((event) => matches(filter, event));
  const items = [...filtered].reverse();

  return (
    <Card className="flex min-h-0 flex-1 flex-col gap-0 py-0">
      <CardHeader className="flex flex-row items-center justify-between gap-2 px-3 py-2.5">
        <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Activity
        </CardTitle>
        <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)}>
          <TabsList className="h-6 p-0.5">
            {FILTERS.map((id) => (
              <TabsTrigger key={id} value={id} className="px-1.5 py-0 text-[10px]">
                {FILTER_LABEL[id]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Badge variant="secondary" className="font-mono text-[10px]">
          {filtered.length}
        </Badge>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 p-0">
        <ScrollArea className="h-full">
          <ul className="flex flex-col gap-1 p-2">
            {items.length === 0 ? (
              <li className="px-2 py-1 text-xs text-muted-foreground">
                {filter === "all"
                  ? "Activity appears here as files change."
                  : `No ${FILTER_LABEL[filter].toLowerCase()} yet.`}
              </li>
            ) : (
              items.map((event) => (
                <li
                  key={event.id}
                  title={formatClock(event.at)}
                  className={cn(
                    "feed-in rounded-sm border border-transparent border-l-2 bg-secondary/30 px-2 py-1.5",
                    SIGNAL_BORDER[event.kind],
                    event.kind === "conflict" && event.by !== "merging-agent" && "conflict-flash",
                  )}
                >
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className={cn("size-1.5 rounded-full", SIGNAL_DOT[event.kind])} />
                    <span className={cn("font-medium", SIGNAL_TEXT[event.kind])}>
                      {KIND_LABEL[event.kind]}
                    </span>
                    {event.path && (
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90">
                        {event.path}
                      </span>
                    )}
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {formatRelative(event.at)}
                    </span>
                  </div>
                  {(event.by || event.detail) && (
                    <div className="mt-0.5 pl-3.5 text-[11px] text-muted-foreground">
                      {event.by ?? "hub"}
                      {event.detail ? `, ${event.detail}` : ""}
                    </div>
                  )}
                </li>
              ))
            )}
          </ul>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
