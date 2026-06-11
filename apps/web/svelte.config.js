import { fileURLToPath, URL } from "node:url";
import adapter from "@sveltejs/adapter-cloudflare";

const protocolDir = fileURLToPath(
	new URL("../../packages/protocol/src", import.meta.url),
);
const sdkDir = fileURLToPath(
	new URL("../../packages/sdk/src", import.meta.url),
);

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		sourcemap: true,
	},
	kit: {
		adapter: adapter(),
		output: {
			bundleStrategy: "split",
		},
		alias: {
			// protocol subpaths — must come before bare package alias to avoid prefix matching
			"@cohub/protocol/core": `${protocolDir}/core/index.ts`,
			"@cohub/protocol/fs": `${protocolDir}/fs/index.ts`,
			"@cohub/protocol/gateway/types": `${protocolDir}/gateway/types.ts`,
			"@cohub/protocol/gateway": `${protocolDir}/gateway/index.ts`,
			"@cohub/protocol/model": `${protocolDir}/model/session.ts`,
			"@cohub/protocol/ports": `${protocolDir}/ports/index.ts`,
			"@cohub/protocol/realtime/types": `${protocolDir}/realtime/types.ts`,
			"@cohub/protocol/realtime/schema": `${protocolDir}/realtime/schema.ts`,
			"@cohub/protocol/realtime": `${protocolDir}/realtime/index.ts`,
			"@cohub/protocol/task": `${protocolDir}/task/index.ts`,
			"@cohub/protocol/generation": `${protocolDir}/generation/index.ts`,
			"@cohub/protocol": `${protocolDir}/index.ts`,
			// sdk subpaths
			"@neta-art/cohub/debugger": `${sdkDir}/debugger.ts`,
			"@neta-art/cohub/http": `${sdkDir}/http.ts`,
			"@neta-art/cohub/websocket": `${sdkDir}/websocket.ts`,
			// bare package aliases — must be last
			"@neta-art/cohub": `${sdkDir}/index.ts`,
		},
	},
};

export default config;
