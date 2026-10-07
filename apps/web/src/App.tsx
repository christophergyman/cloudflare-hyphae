import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ComposerStrip } from "@/components/console/ComposerStrip";
import { ConflictStrip } from "@/components/console/ConflictStrip";
import { FeedPanel } from "@/components/console/FeedPanel";
import { FilesPanel } from "@/components/console/FilesPanel";
import { PresencePanel } from "@/components/console/PresencePanel";
import { PreviewPanel } from "@/components/console/PreviewPanel";
import { TopBar } from "@/components/console/TopBar";
import { useHub } from "@/lib/hub";

export function App() {
  const hub = useHub();
  const [selected, setSelected] = useState<string | null>(null);
  const [checkpointing, setCheckpointing] = useState(false);

  const handleCheckpoint = useCallback(async () => {
    setCheckpointing(true);
    try {
      const committed = await hub.checkpoint();
      if (committed) toast.success("Checkpoint committed to git");
      else toast.info("Nothing new to commit");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "checkpoint failed");
    } finally {
      setCheckpointing(false);
    }
  }, [hub]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <TopBar hub={hub} checkpointing={checkpointing} onCheckpoint={handleCheckpoint} />
      <div className="h-px w-full bg-gradient-to-r from-transparent via-primary/30 to-transparent" />
      <ConflictStrip hub={hub} />
      <main className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)_minmax(300px,380px)] lg:overflow-hidden">
        <div className="flex min-h-0 flex-col gap-3">
          <PresencePanel actors={hub.actors} selfId={hub.actor} />
          <div className="flex min-h-[240px] flex-1 flex-col lg:min-h-0">
            <FilesPanel
              manifest={hub.manifest}
              selected={selected}
              repo={hub.repo}
              connected={hub.status === "open"}
              onSelect={setSelected}
            />
          </div>
        </div>
        <div className="flex min-h-[280px] flex-col lg:min-h-0">
          <PreviewPanel
            key={selected ?? "none"}
            manifest={hub.manifest}
            selected={selected}
            previousHash={hub.previousHash}
          />
        </div>
        <div className="flex min-h-[280px] flex-col lg:min-h-0">
          <FeedPanel events={hub.events} />
        </div>
      </main>
      <ComposerStrip hub={hub} />
    </div>
  );
}
