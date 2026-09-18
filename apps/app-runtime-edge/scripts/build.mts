import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(new URL("../dist/", import.meta.url), { recursive: true });

await Promise.all(["dev", "prod"].map(async (environment) => {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["browser/runtime.ts"],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    write: false,
    define: { __COHUB_RUNTIME_ENV__: JSON.stringify(environment) },
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("Runtime build produced no JavaScript.");
  await writeFile(new URL(`../dist/runtime-${environment}.js.txt`, import.meta.url), output.contents);
}));
