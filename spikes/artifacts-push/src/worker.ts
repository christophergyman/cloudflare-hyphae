/**
 * Spike 1, Worker path.
 *
 * The question: can a Worker create an Artifacts repo and push a commit to it
 * using isomorphic-git?
 *
 * This mirrors Cloudflare's canonical example. It needs a real Artifacts
 * binding and credentials to run, which this environment does not have. The
 * local harness (scripts/local-push.ts) proves the same isomorphic-git code
 * path over smart HTTP without Cloudflare.
 *
 * Deploy and run:
 *   cd spikes/artifacts-push
 *   bunx wrangler dev
 *   curl -X POST http://localhost:8787/push
 */

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memory-fs.ts";

export interface Env {
  ARTIFACTS: Artifacts;
}

interface ArtifactsRepo {
  name: string;
  remote: string;
  token: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/push") {
      return Response.json({ error: "not_found", hint: "POST /push" }, { status: 404 });
    }

    const repoName = `spike-${crypto.randomUUID().slice(0, 8)}`;
    const created = (await env.ARTIFACTS.create(repoName)) as unknown as ArtifactsRepo;

    // Artifacts tokens look like art_v1_<secret>?expires=<unix>. Git Basic auth
    // takes only the secret as the password.
    const tokenSecret = created.token.split("?expires=")[0] ?? created.token;

    const dir = "/workspace";
    const fs = new MemoryFS();
    await git.init({ fs, dir, defaultBranch: "main" });

    await fs.promises.writeFile(`${dir}/README.md`, "# written by the Hyphae spike\n");
    await fs.promises.writeFile(
      `${dir}/src/index.ts`,
      'export const message = "hello from Hyphae";\n',
    );

    await git.add({ fs, dir, filepath: "README.md" });
    await git.add({ fs, dir, filepath: "src/index.ts" });

    const commit = await git.commit({
      fs,
      dir,
      message: "spike: first checkpoint",
      author: { name: "Hyphae Spike", email: "spike@hyphae.dev" },
    });

    const push = await git.push({
      fs,
      http,
      dir,
      url: created.remote,
      ref: "main",
      onAuth: () => ({ username: "x", password: tokenSecret }),
    });

    return Response.json({
      ok: true,
      repo: created.name,
      remote: created.remote,
      commit,
      refs: push.refs,
    });
  },
} satisfies ExportedHandler<Env>;
