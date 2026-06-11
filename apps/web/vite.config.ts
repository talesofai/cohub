import { fileURLToPath, URL } from "node:url";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const MIN_CHUNK_SIZE = 32 * 1024;

function getShikiPackageChunkName(id: string) {
	const normalized = id.replaceAll("\\", "/");
	const languageMatch = normalized.match(
		/@shikijs\/langs\/dist\/([^/?]+)\.mjs/,
	);
	if (languageMatch?.[1]) return `shiki-lang-${languageMatch[1]}`;

	const themeMatch = normalized.match(/@shikijs\/themes\/dist\/([^/?]+)\.mjs/);
	if (themeMatch?.[1]) return `shiki-theme-${themeMatch[1]}`;

	return null;
}

function manualChunkName(id: string) {
	const normalized = id.replaceAll("\\", "/");
	const shikiChunkName = getShikiPackageChunkName(normalized);
	if (shikiChunkName) return shikiChunkName;
	return undefined;
}

const protocolDir = fileURLToPath(
	new URL("../../packages/protocol/src", import.meta.url),
);
const sdkDir = fileURLToPath(
	new URL("../../packages/sdk/src", import.meta.url),
);
export default defineConfig({
	resolve: {
		alias: [
			// protocol subpaths — more specific patterns MUST come before bare package name
			{
				find: /^@cohub\/protocol\/core$/,
				replacement: `${protocolDir}/core/index.ts`,
			},
			{
				find: /^@cohub\/protocol\/model$/,
				replacement: `${protocolDir}/model/session.ts`,
			},
			{
				find: /^@cohub\/protocol\/realtime\/types$/,
				replacement: `${protocolDir}/realtime/types.ts`,
			},
			{
				find: /^@cohub\/protocol\/realtime\/schema$/,
				replacement: `${protocolDir}/realtime/schema.ts`,
			},
			{
				find: /^@cohub\/protocol\/realtime$/,
				replacement: `${protocolDir}/realtime/index.ts`,
			},
			{
				find: /^@cohub\/protocol\/gateway\/types$/,
				replacement: `${protocolDir}/gateway/types.ts`,
			},
			{
				find: /^@cohub\/protocol\/gateway$/,
				replacement: `${protocolDir}/gateway/index.ts`,
			},
			{
				find: /^@cohub\/protocol\/task$/,
				replacement: `${protocolDir}/task/index.ts`,
			},
			{
				find: /^@cohub\/protocol\/fs$/,
				replacement: `${protocolDir}/fs/index.ts`,
			},
			{
				find: /^@cohub\/protocol\/ports$/,
				replacement: `${protocolDir}/ports/index.ts`,
			},
			{
				find: /^@cohub\/protocol\/generation$/,
				replacement: `${protocolDir}/generation/index.ts`,
			},
			{
				find: /^@cohub\/protocol\/platform\/default-space-mods$/,
				replacement: `${protocolDir}/platform/default-space-mods.ts`,
			},
			// protocol bare import — must be last to avoid prefix-matching subpaths
			{
				find: /^@cohub\/protocol$/,
				replacement: `${protocolDir}/index.ts`,
			},
			// sdk subpaths — more specific patterns first
			{
				find: /^@neta-art\/cohub\/http$/,
				replacement: `${sdkDir}/http.ts`,
			},
			{
				find: /^@neta-art\/cohub\/websocket$/,
				replacement: `${sdkDir}/websocket.ts`,
			},
			{
				find: /^@neta-art\/cohub\/debugger$/,
				replacement: `${sdkDir}/debugger.ts`,
			},
			// sdk bare import — must be last
			{
				find: /^@neta-art\/cohub$/,
				replacement: `${sdkDir}/index.ts`,
			},
		],
	},
	dev: {
		sourcemap: {
			js: true,
			css: true,
		},
	},
	server: {
		allowedHosts: true,
	},
	build: {
		chunkSizeWarningLimit: 1200,
		rollupOptions: {
			output: {
				experimentalMinChunkSize: MIN_CHUNK_SIZE,
				manualChunks: manualChunkName,
				onlyExplicitManualChunks: true,
			},
		},
	},
	plugins: [
		tailwindcss(),
		sveltekit(),
		VitePWA({
			registerType: undefined,
			injectRegister: null,
			includeAssets: ["robots.txt", "pwa/*.png"],
			manifest: {
				name: "Cohub",
				short_name: "Cohub",
				description: "AI-powered space collaboration",
				// Keep the installed PWA chrome calm; reserve brand orange for in-app emphasis.
				theme_color: "#1F2026",
				background_color: "#1a1a1a",
				display: "standalone",
				icons: [
					{
						src: "/pwa/icon-192x192.png",
						sizes: "192x192",
						type: "image/png",
					},
					{
						src: "/pwa/icon-512x512.png",
						sizes: "512x512",
						type: "image/png",
					},
				],
			},
			workbox: {
				globPatterns: [
					"**/*.{css,html,ico,png,svg,woff2}",
					"_app/immutable/entry/*.js",
					"_app/immutable/nodes/*.js",
					"_app/version.json",
				],
				navigateFallback: undefined,
				runtimeCaching: [
					{
						urlPattern: ({ url }) =>
							url.pathname.startsWith("/_app/immutable/"),
						handler: "CacheFirst",
						options: {
							cacheName: "immutable-assets",
							expiration: {
								maxEntries: 240,
								maxAgeSeconds: 60 * 60 * 24 * 30,
							},
						},
					},
				],
			},
		}),
	],
});
