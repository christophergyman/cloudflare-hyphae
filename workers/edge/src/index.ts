/**
 * The edge Worker: auth, routing, REST, WebSocket upgrade, and blob presign
 * (ADR-002, ADR-012, ADR-020).
 *
 * Phase 0 scaffold: health is real, the rest is stubbed with clear 501s so the
 * shape is visible to the next agent filling it in.
 */

export interface Env {
  BLOBS: R2Bucket;
  ENVIRONMENT?: string;
}

const SERVICE = "hyphae-edge" as const;
const VERSION = "0.0.0" as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    void env;
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: SERVICE, version: VERSION });
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

    return Response.json({ error: "not_found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
