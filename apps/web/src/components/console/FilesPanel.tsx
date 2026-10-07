import type { ManifestEntry } from "@hyphae/protocol";
import { Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatRelative } from "@/lib/format";

interface FilesPanelProps {
  manifest: Map<string, ManifestEntry>;
  selected: string | null;
  repo: string;
  connected: boolean;
  onSelect: (path: string) => void;
}

export function FilesPanel({ manifest, selected, repo, connected, onSelect }: FilesPanelProps) {
  const rows = [...manifest.entries()].sort(([a], [b]) => a.localeCompare(b));
  const [copied, setCopied] = useState(false);

  const cliCommand = `hyphae up ./your-folder --hub ${location.origin} --repo ${repo}`;

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(cliCommand);
      setCopied(true);
      toast.success("Command copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("clipboard unavailable");
    }
  };

  return (
    <Card className="flex min-h-0 flex-1 flex-col gap-0 py-0">
      <CardHeader className="flex flex-row items-center justify-between px-3 py-2.5">
        <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Files
        </CardTitle>
        <Badge variant="secondary" className="font-mono text-[10px]">
          {rows.length}
        </Badge>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 p-0">
        <ScrollArea className="h-full">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-3">Path</TableHead>
                <TableHead className="w-12">Ver</TableHead>
                <TableHead className="w-24">By</TableHead>
                <TableHead className="w-24 pr-3 text-right">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="p-3">
                    {connected ? (
                      <div className="grid gap-2">
                        <p className="text-xs text-muted-foreground">
                          No files yet. Start a client in a terminal:
                        </p>
                        <div className="flex items-start gap-2">
                          <code className="min-w-0 flex-1 rounded-sm border bg-secondary/40 px-2 py-1.5 font-mono text-[11px] break-all">
                            {cliCommand}
                          </code>
                          <Button size="xs" variant="ghost" onClick={copyCommand} title="Copy">
                            <Copy data-icon="inline-start" />
                            {copied ? "Copied" : "Copy"}
                          </Button>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          or write a file with the composer below.
                        </p>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Connect to a repo to see its files.
                      </p>
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map(([path, entry]) => (
                  <TableRow
                    key={path}
                    data-state={path === selected ? "selected" : undefined}
                    className="cursor-pointer"
                    onClick={() => onSelect(path)}
                  >
                    <TableCell className="pl-3 font-mono text-xs">{path}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      v{entry.version}
                    </TableCell>
                    <TableCell className="max-w-24 truncate text-xs text-muted-foreground">
                      {entry.updatedBy}
                    </TableCell>
                    <TableCell className="pr-3 text-right text-xs text-muted-foreground">
                      {formatRelative(entry.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
