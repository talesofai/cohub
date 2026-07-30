import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	isReservedPublicIdentifier,
	parseUsername,
} from "@cohub/protocol/public-identifiers";

const testsDir = dirname(fileURLToPath(import.meta.url));
const routesDir = resolve(testsDir, "../routes");
const staticDir = resolve(testsDir, "../../static");

async function fixedTopLevelRouteSegments(): Promise<Set<string>> {
	const segments = new Set<string>();
	for (const entry of await readdir(routesDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (/^\(.+\)$/.test(entry.name)) {
			for (const child of await readdir(resolve(routesDir, entry.name), {
				withFileTypes: true,
			})) {
				if (child.isDirectory() && !child.name.startsWith("[")) {
					segments.add(child.name);
				}
			}
			continue;
		}
		if (!entry.name.startsWith("[")) segments.add(entry.name);
	}
	return segments;
}

async function fixedStaticSegments(): Promise<Set<string>> {
	const segments = new Set<string>();
	for (const entry of await readdir(staticDir, { withFileTypes: true })) {
		if (entry.isDirectory()) segments.add(entry.name);
	}
	return segments;
}

test("all username-compatible platform root paths are reserved", async () => {
	const segments = new Set([
		...(await fixedTopLevelRouteSegments()),
		...(await fixedStaticSegments()),
	]);
	const reservableSegments = [...segments]
		.map((segment) => parseUsername(segment))
		.filter((segment): segment is string => Boolean(segment))
		.sort();

	for (const segment of reservableSegments) {
		assert.equal(
			isReservedPublicIdentifier("username", segment),
			true,
			`/${segment} must be reserved before it can ship as a platform path`,
		);
	}
});
