import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Actor } from "@/lib/hub";
import { cn } from "@/lib/utils";

interface PresencePanelProps {
  actors: Actor[];
  selfId: string;
}

/** Humans are dots, agents are diamonds. Observers are labeled, not faked. */
export function PresencePanel({ actors, selfId }: PresencePanelProps) {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-row items-center justify-between px-3 py-2.5">
        <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Actors
        </CardTitle>
        <Badge variant="secondary" className="font-mono text-[10px]">
          {actors.length}
        </Badge>
      </CardHeader>
      <CardContent className="px-3 pb-3">
        {actors.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nobody connected. Invite a teammate or run a CLI client.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {actors.map((actor) => {
              const isSelf = actor.actorId === selfId;
              return (
                <span
                  key={actor.actorId}
                  title={actor.actorId}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-sm border bg-secondary/60 px-2 py-1 text-xs",
                    isSelf && "border-foreground/40",
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5",
                      actor.kind === "agent"
                        ? "rotate-45 bg-signal-resolved"
                        : "rounded-full bg-signal-merge",
                    )}
                  />
                  <span className="max-w-28 truncate">{actor.displayName}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {isSelf ? "you" : actor.observer ? "view" : actor.kind}
                  </span>
                </span>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
