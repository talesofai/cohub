import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "cohub-agent-runtime": "../local-runtime/src/host.ts",
  },
  format: "esm",
  outDir: "dist",
  clean: false,
  dts: false,
  target: "node24",
  tsconfig: "../local-runtime/tsconfig.build.json",
  deps: {
    onlyBundle: ["zod"],
    neverBundle: [
      /^@anthropic-ai\//,
      /^@earendil-works\//,
      /^@openai\//,
    ],
  },
  outExtensions: () => ({ js: ".js" }),
});
