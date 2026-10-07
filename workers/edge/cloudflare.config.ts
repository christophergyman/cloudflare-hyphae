import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig({
  worker: {
    name: "hyphae-edge",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/index.ts",
    observability: {
      enabled: true,
    },
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/health", "/repos/*", "/blobs/*", "/blobs", "/agents/*"],
    },
    env: {
      ENVIRONMENT: bindings.text("production"),
      ARTIFACTS: bindings.artifacts({
        namespace: "default",
      }),
      BLOBS: bindings.r2({
        name: "hyphae-blobs",
      }),
      Hub: bindings.durableObject({
        worker: "hyphae-edge",
        exportName: "Hub",
      }),
      AI: bindings.ai({}),
      ASSETS: bindings.assets(),
    },
    exports: {
      Hub: exports.durableObject({
        storage: "sqlite",
      }),
    },
  },
});
