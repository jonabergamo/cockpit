import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      COCKPIT_CONFIG: new URL("../config.example.toml", import.meta.url).pathname,
      COCKPIT_DATA: "/tmp/cockpit-test-data",
    },
  },
});
