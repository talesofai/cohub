import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const appCss = readFileSync(new URL("../app.css", import.meta.url), "utf8");
const workSurface = readFileSync(
	new URL("../lib/components/work/WorkSurface.svelte", import.meta.url),
	"utf8",
);
const publicWorkPage = readFileSync(
	new URL(
		"../routes/(public)/[username]/[spaceSlug]/w/[workSlug]/+page.svelte",
		import.meta.url,
	),
	"utf8",
);

test("public Works fit Safari's visible viewport in every render state", () => {
	const viewportRule = cssRule(appCss, ".public-work-viewport");

	assert.match(viewportRule, /--public-work-viewport-height:\s*100vh/);
	assert.match(viewportRule, /height:\s*var\(--public-work-viewport-height\)/);
	assert.match(viewportRule, /overflow:\s*hidden/);
	assert.match(viewportRule, /overscroll-behavior:\s*none/);
	assert.match(
		appCss,
		/@supports \(height: 100svh\)[\s\S]*--public-work-viewport-height:\s*100svh/,
	);
	assert.match(
		appCss,
		/@supports \(height: 100dvh\)[\s\S]*--public-work-viewport-height:\s*100dvh/,
	);
	assert.match(workSurface, /work-surface page public-work-viewport/);
	assert.match(
		workSurface,
		/\.work-surface\.page \.work-frame\s*\{[^}]*height:\s*100%/s,
	);
	assert.doesNotMatch(workSurface, /(?:min-)?height:\s*100vh/);
	assert.equal(publicWorkPage.match(/public-work-viewport/g)?.length, 3);
	assert.doesNotMatch(publicWorkPage, /min-h-screen/);
});

function cssRule(source: string, selector: string): string {
	const start = source.indexOf(`${selector} {`);
	assert.notEqual(start, -1, `Missing ${selector} rule`);
	const end = source.indexOf("}", start);
	assert.notEqual(end, -1, `Unclosed ${selector} rule`);
	return source.slice(start, end + 1);
}
