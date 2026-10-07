import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "hyphae-spike-artifacts-push",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/worker.ts",
    env: {
      ARTIFACTS: bindings.artifacts({
        namespace: "default",
      }),
    },
  },
});
