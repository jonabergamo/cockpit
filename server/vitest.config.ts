import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      COCKPIT_CONFIG: new URL("../config.example.toml", import.meta.url).pathname,
      COCKPIT_DATA: "/tmp/cockpit-test-data",
      // a machine set up as a node or hub runs its tests as a single one
      COCKPIT_ROLE: "all",
    },
  },
});
