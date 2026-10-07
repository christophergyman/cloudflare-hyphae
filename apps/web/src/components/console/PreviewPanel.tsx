import type { ManifestEntry } from "@hyphae/protocol";
import { FileText } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type DiffLine, diffLines } from "@/lib/diff";
import { formatBytes, shortHash } from "@/lib/format";
import { fetchBlob } from "@/lib/hub";
import { cn } from "@/lib/utils";

interface PreviewPanelProps {
  manifest: Map<string, ManifestEntry>;
  selected: string | null;
  previousHash: (path: string) => string | undefined;
}

interface PreviewState {
  loading: boolean;
  text: string | null;
  bytes: number;
  failed: boolean;
}

const EMPTY: PreviewState = { loading: false, text: null, bytes: 0, failed: false };

export function PreviewPanel({ manifest, selected, previousHash }: PreviewPanelProps) {
  const entry = selected ? manifest.get(selected) : undefined;
  const hash = entry?.blobHash;
  const prevHash = selected ? previousHash(selected) : undefined;
  const [tab, setTab] = useState("content");
  const [state, setState] = useState<PreviewState>(EMPTY);
  const [diff, setDiff] = useState<{ loading: boolean; lines: DiffLine[] | null; error?: string }>({
    loading: false,
    lines: null,
  });

  useEffect(() => {
    if (!hash) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;
    setState({ loading: true, text: null, bytes: 0, failed: false });
    fetchBlob(hash)
      .then(({ text, bytes }) => {
        if (!cancelled) setState({ loading: false, text, bytes, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ loading: false, text: null, bytes: 0, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [hash]);

  useEffect(() => {
    if (tab !== "diff" || !hash || !prevHash) return;
    let cancelled = false;
    setDiff({ loading: true, lines: null });
    Promise.all([fetchBlob(prevHash), fetchBlob(hash)])
      .then(([before, after]) => {
        if (cancelled) return;
        if (before.text === null || after.text === null) {
          setDiff({ loading: false, lines: null, error: "binary content cannot be diffed" });
          return;
        }
        setDiff({ loading: false, lines: diffLines(before.text, after.text) });
      })
      .catch(() => {
        if (!cancelled)
          setDiff({ loading: false, lines: null, error: "could not fetch both versions" });
      });
    return () => {
      cancelled = true;
    };
  }, [tab, hash, prevHash]);

  return (
    <Card className="flex min-h-0 flex-1 flex-col gap-0 py-0">
      <CardHeader className="flex flex-row items-center gap-2 px-3 py-2.5">
        <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Preview
        </CardTitle>
        {selected && (
          <>
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{selected}</span>
            {entry && (
              <Badge variant="secondary" className="font-mono text-[10px]">
                v{entry.version}
              </Badge>
            )}
            {hash && (
              <span className="font-mono text-[10px] text-muted-foreground">{shortHash(hash)}</span>
            )}
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="h-6 p-0.5">
                <TabsTrigger value="content" className="px-2 py-0 text-[10px]">
                  Content
                </TabsTrigger>
                <TabsTrigger value="diff" className="px-2 py-0 text-[10px]" disabled={!prevHash}>
                  Diff
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </>
        )}
      </CardHeader>
      <CardContent className="min-h-0 flex-1 p-0">
        <ScrollArea className="h-full">
          <div className="p-3">
            {!selected ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <FileText className="size-3.5" />
                select a file to preview its current content
              </p>
            ) : tab === "diff" ? (
              diff.loading ? (
                <p className="text-xs text-muted-foreground">fetching both versions...</p>
              ) : diff.error ? (
                <p className="text-xs text-muted-foreground">{diff.error}</p>
              ) : diff.lines === null ? (
                <p className="text-xs text-muted-foreground">
                  no previous version seen while this tab was open
                </p>
              ) : (
                <pre className="font-mono text-xs leading-relaxed">
                  {diff.lines.map((line) => (
                    <span
                      key={line.id}
                      className={cn(
                        "block whitespace-pre-wrap break-words",
                        line.type === "add" && "bg-foreground/5 text-foreground",
                        line.type === "del" && "text-muted-foreground/60",
                        line.type === "same" && "text-muted-foreground/80",
                      )}
                    >
                      {line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "}
                      {line.text}
                    </span>
                  ))}
                </pre>
              )
            ) : state.loading ? (
              <p className="text-xs text-muted-foreground">loading blob...</p>
            ) : state.failed ? (
              <p className="text-xs text-signal-error">could not fetch the blob</p>
            ) : state.text === null ? (
              <p className="text-xs text-muted-foreground">
                binary content, {formatBytes(state.bytes)} (preview not rendered)
              </p>
            ) : (
              <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
                {state.text}
              </pre>
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
