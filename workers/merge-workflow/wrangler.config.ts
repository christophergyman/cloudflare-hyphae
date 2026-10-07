import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
  // Bindings types are committed in worker-configuration.d.ts, so build-time
  // generation stays off. Regenerate with `cf workers types` and copy the
  // result; see the README "Types" section.
  types: {
    generate: false,
  },
});
