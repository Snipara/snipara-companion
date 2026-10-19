import { defineConfig } from "tsup";

export default defineConfig({
  target: "node18",
  // The public CommonJS entry point must not require ESM-only runtime packages.
  // Bundle their dependency graphs so Node 18 loads the same CLI as newer hosts.
  noExternal: ["chalk", "conf"],
});
