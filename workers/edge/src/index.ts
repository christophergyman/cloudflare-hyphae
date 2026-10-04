/**
 * The edge Worker: auth, routing, REST, WebSocket upgrade, and blob presign
 * (ADR-002, ADR-012, ADR-020).
 *
 * WebSocket upgrades to the Hub are routed through the Agents SDK's
 * `routeAgentRequest`, which maps `/agents/:agent/:name` to the named Hub
 * instance. One Hub per repo: the repo name is the agent name.
 */

import { sha256Hex } from "@hyphae/core";
import type { Hub } from "@hyphae/hub";
import { routeAgentRequest } from "agents";

export interface Env {
  BLOBS: R2Bucket;
  /** The Hub Durable Object namespace (bound as `Hub` in wrangler.toml). */
  Hub: DurableObjectNamespace<Hub>;
  /** Static assets (apps/web/public): the live view. */
  ASSETS?: { fetch(request: Request): Promise<Response> };
  /** Workers AI binding, passed through to the Hub. */
  AI?: { run(model: string, options: unknown): Promise<unknown> };
  /** Merge model name (see wrangler.toml). */
  MODEL?: string;
  ENVIRONMENT?: string;
}

const SERVICE = "hyphae-edge" as const;
const VERSION = "0.0.0" as const;
/** Maximum blob size accepted at the edge, matching the protocol's inline cap. */
const MAX_BLOB_BYTES = 1_500_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: SERVICE, version: VERSION });
    }

    // Route WebSocket upgrades and Hub HTTP to the per-repo Agent.
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // Force a checkpoint (manual trigger, ADR-006). The Hub's public
    // `checkpoint()` method is called through its Durable Object stub.
    const commitMatch = url.pathname.match(/^\/repos\/([^/]+)\/commit$/);
    if (commitMatch && request.method === "POST") {
      const repoName = commitMatch[1] as string;
      const id = env.Hub.idFromName(repoName);
      const stub = env.Hub.get(id);
      const result = await stub.checkpoint();
      return Response.json(result);
    }

    // Read a repo's current manifest (used by the live view's file list).
    const manifestMatch = url.pathname.match(/^\/repos\/([^/]+)\/manifest$/);
    if (manifestMatch && request.method === "GET") {
      const repoName = manifestMatch[1] as string;
      const id = env.Hub.idFromName(repoName);
      const stub = env.Hub.get(id);
      return Response.json(await stub.manifest());
    }

    // Recent activity for a repo (used by the live view on first load).
    const historyMatch = url.pathname.match(/^\/repos\/([^/]+)\/history$/);
    if (historyMatch && request.method === "GET") {
      const repoName = historyMatch[1] as string;
      const id = env.Hub.idFromName(repoName);
      const stub = env.Hub.get(id);
      return Response.json(await stub.recentEvents());
    }

    // Content upload (small files). In production this becomes an R2 presigned
    // PUT (ADR-020); this direct endpoint keeps the client simple for now.
    if (url.pathname === "/blobs" && request.method === "PUT") {
      // Bound the body so a client cannot OOM the isolate or fill R2 with one
      // request. Matches the protocol's inline-content ceiling (ADR-020).
      const length = Number(request.headers.get("content-length") ?? "0");
      if (length > MAX_BLOB_BYTES) {
        return Response.json(
          { error: "payload_too_large", limit: MAX_BLOB_BYTES },
          { status: 413 },
        );
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > MAX_BLOB_BYTES) {
        return Response.json(
          { error: "payload_too_large", limit: MAX_BLOB_BYTES },
          { status: 413 },
        );
      }
      const hash = await sha256Hex(bytes);
      await env.BLOBS.put(hash, bytes);
      return Response.json({ hash });
    }

    if (url.pathname.startsWith("/blobs/") && request.method === "GET") {
      const hash = url.pathname.slice("/blobs/".length);
      const obj = await env.BLOBS.get(hash);
      if (!obj) return new Response("not found", { status: 404 });
      return new Response(await obj.arrayBuffer());
    }

    // ADR-020: mint a presigned R2 PUT or GET URL for direct client transfer.
    // Two implementation options to settle in the presign spike:
    //   1. R2 S3 API with account access keys (aws4fetch / aws-sdk getSignedUrl).
    //   2. Proxy the transfer through the Worker (simpler, no S3 keys).
    if (url.pathname === "/blobs/presign") {
      return Response.json(
        { error: "not_implemented", detail: "R2 presign lands in the presign spike (ADR-020)" },
        { status: 501 },
      );
    }

    // Anything else: serve the live view from static assets.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// Re-export the Hub so the Durable Object class is available to the Worker.
export { Hub } from "@hyphae/hub";
