/**
 * Deployment entry for the verified merge Workflow (ADR-014).
 *
 * This is the only module that imports workerd-only runtime APIs (`DurableObject`
 * here, `WorkflowEntrypoint` in ./workflow.ts). src/index.ts and src/runner.ts
 * stay runtime-agnostic so Bun can unit-test the merge wiring.
 *
 * Routes:
 *   POST /merge      start a conflict job, returns { id } (202)
 *   GET  /merge/:id  status of a started job
 *   GET  /health     liveness probe
 */

import { DurableObject } from "cloudflare:workers";
import type { ConflictJob } from "./runner.ts";
import type { MergeWorkflowEnv } from "./workflow.ts";

export * from "./index.ts";
export { MergeWorkflow } from "./workflow.ts";

/**
 * Container-backed verifier. The `durable_object` scheduling policy lets the
 * Durable Object choose the image at start time, so no image build is needed
 * for the Cloudflare-managed Debian image. Repo tests may need to install
 * dependencies, so outbound Internet is on for now; harden with
 * `interceptAllOutboundHttp` before running untrusted repos (ADR-014).
 */
const SANDBOX_IMAGE = "cloudflare/debian-trixie";

export class Sandbox extends DurableObject<MergeWorkflowEnv> {
  private container(): Container {
    const container = this.ctx.container;
    if (!container) {
      throw new Error("Sandbox has no container: check the [[containers]] binding");
    }
    if (!container.running) {
      container.start({
        image: SANDBOX_IMAGE,
        entrypoint: ["sleep", "infinity"],
        enableInternet: true,
      });
    }
    return container;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const container = this.container();
    // Pass the path as a positional argument so it is never interpreted as
    // shell syntax; the file body arrives over stdin.
    const process = await container.exec(
      ["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path],
      { stdin: "pipe" },
    );
    const stdin = process.stdin;
    if (stdin) {
      const writer = stdin.getWriter();
      await writer.write(new TextEncoder().encode(content));
      await writer.close();
    }
    await process.exitCode;
  }

  async exec(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const container = this.container();
    // exec() runs an executable directly, so invoke a shell explicitly.
    const process = await container.exec(["sh", "-lc", command]);
    const output = await process.output();
    return {
      exitCode: output.exitCode,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function isConflictJob(value: unknown): value is ConflictJob {
  if (typeof value !== "object" || value === null) return false;
  const job = value as Record<string, unknown>;
  return (
    typeof job.repoId === "string" &&
    typeof job.path === "string" &&
    typeof job.base === "string" &&
    typeof job.ours === "string" &&
    typeof job.theirs === "string"
  );
}

export default {
  async fetch(request: Request, env: MergeWorkflowEnv): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/health") {
      return json({ ok: true });
    }

    if (request.method === "POST" && pathname === "/merge") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      if (!isConflictJob(body)) {
        return json({ error: "body must be a ConflictJob" }, 400);
      }
      const instance = await env.MERGE_WORKFLOW.create({ params: body });
      return json({ id: instance.id }, 202);
    }

    const match = /^\/merge\/([^/]+)$/.exec(pathname);
    if (request.method === "GET" && match?.[1]) {
      const id = decodeURIComponent(match[1]);
      try {
        const instance = await env.MERGE_WORKFLOW.get(id);
        return json(await instance.status());
      } catch {
        return json({ error: `no merge instance ${id}` }, 404);
      }
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<MergeWorkflowEnv>;
