import { RefreshCw, Save, UserPlus } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { BrandGlyph, StatusDot } from "@/components/console/chrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatRelative } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import type { HubApi } from "@/lib/hub";

interface TopBarProps {
  hub: HubApi;
  checkpointing: boolean;
  onCheckpoint: () => void;
}

/** alice -> alice-2, alice-2 -> alice-3. Cheap, predictable invite names. */
function suggestGuest(actor: string): string {
  const match = /^(.*?)(\d+)$/.exec(actor);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    return `${match[1]}${Number(match[2]) + 1}`;
  }
  return `${actor}-2`;
}

export function TopBar({ hub, checkpointing, onCheckpoint }: TopBarProps) {
  const [repo, setRepo] = useState(hub.repo);
  const [actorDraft, setActorDraft] = useState(hub.actor);
  const now = useNow(3000);
  const live = hub.status === "open";
  // While reconnecting the tab is still "in" the repo: the button cancels,
  // and Retry (next to the status) is the immediate path back.
  const connected = live || hub.status === "reconnecting";

  useEffect(() => {
    if (hub.repo) setRepo(hub.repo);
  }, [hub.repo]);
  useEffect(() => {
    setActorDraft(hub.actor);
  }, [hub.actor]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (connected) {
      hub.disconnect();
    } else {
      hub.connect(repo);
    }
  };

  const commitActor = () => {
    const next = actorDraft.trim();
    if (next && next !== hub.actor) hub.setActor(next);
  };

  const invite = async () => {
    const guest = suggestGuest(hub.actor);
    const url = new URL(location.href);
    url.search = new URLSearchParams({ repo: hub.repo, actor: guest }).toString();
    try {
      await navigator.clipboard.writeText(url.toString());
      toast.success(`Invite link copied, opens as ${guest}`);
    } catch {
      toast.error("clipboard unavailable, copy the address bar instead");
    }
  };

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-card/60 px-4 py-2.5">
      <div className="flex items-center gap-2">
        <BrandGlyph className="size-5 text-primary" />
        <span className="font-heading text-sm font-semibold tracking-tight">Hyphae</span>
        <span className="text-xs text-muted-foreground">console</span>
      </div>

      <form onSubmit={submit} className="flex items-center gap-2">
        <Input
          value={repo}
          onChange={(event) => setRepo(event.target.value)}
          placeholder="repo name"
          aria-label="repo name"
          className="h-8 w-40 font-mono text-xs"
          disabled={connected}
        />
        <Button
          type="submit"
          size="sm"
          variant={connected ? "outline" : "default"}
          disabled={!connected && !repo.trim()}
        >
          {connected ? "Disconnect" : "Connect"}
        </Button>
      </form>

      <div className="flex items-center gap-2">
        <StatusDot status={hub.status} />
        {hub.status === "reconnecting" && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>
              attempt {hub.attempts}
              {hub.lastEventAt ? `, last update ${formatRelative(hub.lastEventAt)}` : ""}
            </span>
            <Button size="xs" variant="ghost" onClick={hub.retry}>
              <RefreshCw data-icon="inline-start" />
              Retry
            </Button>
          </span>
        )}
        {live && hub.lastEventAt !== null && now - hub.lastEventAt > 45_000 && (
          <span className="text-xs text-muted-foreground">
            quiet for {formatRelative(hub.lastEventAt)}
          </span>
        )}
      </div>

      {connected && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">you</span>
          <Input
            value={actorDraft}
            onChange={(event) => setActorDraft(event.target.value)}
            onBlur={commitActor}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitActor();
              }
            }}
            aria-label="your name"
            className="h-8 w-32 font-mono text-xs"
          />
          <Button size="sm" variant="outline" onClick={invite}>
            <UserPlus data-icon="inline-start" />
            Invite
          </Button>
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={onCheckpoint}
          disabled={!live || checkpointing}
        >
          <Save data-icon="inline-start" />
          {checkpointing ? "Committing" : "Checkpoint"}
        </Button>
      </div>
    </header>
  );
}
