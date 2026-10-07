import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { HubApi } from "@/lib/hub";
import { runBigFile, runCleanMerge, runConflict } from "@/lib/scenarios";

interface ComposerStripProps {
  hub: HubApi;
}

/**
 * The always-visible composer: act as a client without leaving the browser,
 * and fire one-click scenarios that exercise the merge paths.
 */
export function ComposerStrip({ hub }: ComposerStripProps) {
  const [path, setPath] = useState("notes/hello.txt");
  const [content, setContent] = useState("hello from the console\n");
  const [busy, setBusy] = useState<string | null>(null);
  const live = hub.status === "open";

  if (hub.viewOnly) {
    return (
      <footer className="border-t bg-card/60 px-4 py-2 text-xs text-muted-foreground">
        View-only link. Remove <span className="font-mono">view=1</span> from the URL to send
        changes.
      </footer>
    );
  }

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    try {
      const message = await fn();
      toast.success(message);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `${label} failed`);
    } finally {
      setBusy(null);
    }
  };

  const write = () => {
    const target = path.trim();
    if (!target) return;
    void run("write", async () => {
      await hub.sendChange(target, content);
      return `Wrote ${target}`;
    });
  };

  const remove = () => {
    const target = path.trim();
    if (!target) return;
    void run("delete", async () => {
      await hub.sendDeletion(target);
      return `Deleted ${target}`;
    });
  };

  const cleanMerge = () =>
    void run("clean", async () => {
      const { path: scenarioPath, note } = await runCleanMerge(hub);
      return `${scenarioPath}: ${note}`;
    });

  const conflict = () =>
    void run("conflict", async () => {
      const { path: scenarioPath, note } = await runConflict(hub);
      return `${scenarioPath}: ${note}`;
    });

  const bigFile = () =>
    void run("big", async () => {
      const { path: scenarioPath, note } = await runBigFile(hub);
      return `${scenarioPath}: ${note}`;
    });

  const disabled = !live || busy !== null;

  return (
    <footer className="border-t bg-card/60">
      <div className="flex flex-col gap-3 px-4 py-2.5 lg:flex-row lg:items-end">
        <div className="grid flex-1 gap-2 lg:grid-cols-[minmax(180px,240px)_minmax(0,1fr)]">
          <div className="grid gap-1">
            <Label
              htmlFor="composer-path"
              className="text-[10px] uppercase tracking-wider text-muted-foreground"
            >
              Path
            </Label>
            <Input
              id="composer-path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              className="h-8 font-mono text-xs"
              disabled={disabled}
            />
          </div>
          <div className="grid gap-1">
            <Label
              htmlFor="composer-content"
              className="text-[10px] uppercase tracking-wider text-muted-foreground"
            >
              Content
            </Label>
            <Textarea
              id="composer-content"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              rows={2}
              className="min-h-8 font-mono text-xs"
              disabled={disabled}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <Button size="sm" onClick={write} disabled={disabled || !path.trim()}>
            Write
          </Button>
          <Button size="sm" variant="outline" onClick={remove} disabled={disabled || !path.trim()}>
            Delete
          </Button>
          <div className="mx-1 hidden h-6 w-px self-center bg-border lg:block" />
          <span className="self-center text-[10px] uppercase tracking-wider text-muted-foreground">
            Simulate
          </span>
          <Button size="sm" variant="secondary" onClick={cleanMerge} disabled={disabled}>
            Clean merge
          </Button>
          <Button size="sm" variant="secondary" onClick={conflict} disabled={disabled}>
            Conflict
          </Button>
          <Button size="sm" variant="secondary" onClick={bigFile} disabled={disabled}>
            Big file
          </Button>
        </div>
      </div>
      {!live && (
        <p className="px-4 pb-2 text-[11px] text-muted-foreground">
          Connect to a repo to send changes.
        </p>
      )}
    </footer>
  );
}
