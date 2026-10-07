import { bindings, defineConfig, defineContainer, exports } from "cf/config";

/**
 * The Container application is Durable Object-managed (ADR-014): the Sandbox
 * Durable Object starts an isolated container per merge attempt, so the image
 * is chosen at start time. The migration kept this scheduling policy from the
 * Wrangler config.
 *
 * The name must match the application the previous Wrangler deploys created
 * (`<worker>-<class>` naming), because a Durable Object namespace can be linked
 * to exactly one container application.
 */
const sandbox = defineContainer({
  name: "hyphae-merge-workflow-sandbox",
  schedulingPolicy: "durable-object",
});

export default defineConfig({
  containers: [sandbox],
  worker: {
    name: "hyphae-merge-workflow",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/worker.ts",
    observability: {
      enabled: true,
    },
    env: {
      // cf migrate gives every self-referencing Durable Object binding a
      // `script_name`, and cf 1.0.0-beta.12 rejects any `script_name` on the
      // class that a container is attached to, even when it names this same
      // Worker. This raw binding is exactly what wrangler.toml produced and
      // what the platform expects: a class_name with no script_name. Revisit
      // when cf resolves self-references (cf migrate TODO links to
      // https://developers.cloudflare.com/workers/runtime-apis/context/#exports).
      SANDBOX: {
        type: "unsafe:durable_object_namespace",
        class_name: "Sandbox",
      },
      MERGE_WORKFLOW: bindings.workflow({
        name: "merge-workflow",
        worker: "hyphae-merge-workflow",
        exportName: "MergeWorkflow",
      }),
      AI: bindings.ai({}),
    },
    exports: {
      Sandbox: exports.durableObject({
        storage: "sqlite",
        container: sandbox,
      }),
      MergeWorkflow: exports.workflow({
        name: "merge-workflow",
      }),
    },
  },
});
