import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AppMarketplaceCatalogSchema,
	InstalledAppSourceSchema,
	marketplaceEntryToInstalledApp,
	parseCanonicalAppRef,
} from "./src/app-catalog.js";

test("canonical app refs use username/space/app without the public route marker", () => {
	assert.equal(parseCanonicalAppRef("Alice/studio/notes"), "alice/studio/notes");
	assert.equal(parseCanonicalAppRef("alice/studio/w/notes"), null);
	assert.equal(parseCanonicalAppRef("alice/studio"), null);
});

test("marketplace entries omit optional metadata when it was not declared", () => {
	const catalog = AppMarketplaceCatalogSchema.parse({
		format: "cohub.app-marketplace",
		version: 1,
		apps: [{
			id: "00000000-0000-4000-8000-000000000001",
			ref: "alice/studio/notes",
			name: "Notes",
			url: "https://apps.example.test/notes",
		}],
	});
	const [entry] = catalog.apps;
	assert.ok(entry);
	const installed = marketplaceEntryToInstalledApp(entry);
	assert.equal(installed.id, "00000000-0000-4000-8000-000000000001");
	assert.equal(installed.ref, "alice/studio/notes");
	assert.deepEqual(installed.snapshot, { name: "Notes" });
	assert.deepEqual(installed.source, {
		type: "marketplace",
		catalog: "cohub",
		appId: "00000000-0000-4000-8000-000000000001",
	});
});

test("custom catalogs can be retained as a source without changing the app id", () => {
	assert.deepEqual(
		InstalledAppSourceSchema.parse({
			type: "marketplace",
			catalog: "https://example.test/apps.json",
			appId: "custom-notes",
		}),
		{
			type: "marketplace",
			catalog: "https://example.test/apps.json",
			appId: "custom-notes",
		},
	);
});
