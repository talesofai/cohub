import { svelte } from "@sveltejs/vite-plugin-svelte";
import { loadEnv, defineConfig } from "vite";

// Catalog source baked into the build. Override per environment with
// `CATALOG_URL=https://... npm run build` (shell env or .env file).
const DEFAULT_CATALOG_URL =
  "https://public.cohub.live/p/1de0f2fc-1ab6-4072-9d77-9781a1870b85/marketplace-catalog.v1.json";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const catalogUrl = process.env.CATALOG_URL || env.CATALOG_URL || DEFAULT_CATALOG_URL;
  if (!/^https?:\/\//.test(catalogUrl)) {
    throw new Error(`CATALOG_URL must be an http(s) URL, got: ${catalogUrl}`);
  }

  return {
    base: "./",
    plugins: [svelte()],
    define: {
      "import.meta.env.__CATALOG_URL__": JSON.stringify(catalogUrl),
    },
    build: { target: "es2022", sourcemap: false },
  };
});
