#!/usr/bin/env tsx
/**
 * Render entries.json to CHANGELOG.md and tag message text.
 *
 * Usage:
 *   tsx scripts/changelog/render.ts                  # full CHANGELOG.md
 *   tsx scripts/changelog/render.ts --tag v1.98.0    # single entry for tag message
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ChangelogEntry, readEntries } from "./shared.ts";

const CHANGELOG_PATH = join(process.cwd(), "CHANGELOG.md");

function renderEntry(entry: ChangelogEntry): string {
	const lines: string[] = [];
	lines.push(`## v${entry.version} — ${entry.date}\n`);
	for (const h of entry.highlights) {
		lines.push(`- ${h}`);
	}
	if (entry.fixes?.length) {
		lines.push("\n### Bug Fixes\n");
		for (const f of entry.fixes) {
			lines.push(`- ${f}`);
		}
	}
	return lines.join("\n");
}

function renderChangelog(): string {
	const entries = readEntries();
	const header = `# Changelog

All notable changes to Cohub are documented in this file.

<!-- Generated from apps/web/src/lib/changelog/entries.json. Do not edit. -->
`;
	return `${header}\n${entries.map(renderEntry).join("\n\n")}\n`;
}

function renderTagMessage(tag: string): string {
	const entries = readEntries();
	const entry = entries.find((e) => e.tags.includes(tag));
	if (!entry) throw new Error(`no entry found for tag ${tag}`);
	return renderEntry(entry);
}

function main() {
	const args = process.argv.slice(2);
	const tagIndex = args.indexOf("--tag");
	if (tagIndex >= 0) {
		const tag = args[tagIndex + 1];
		if (!tag) {
			console.error("Usage: tsx scripts/changelog/render.ts --tag <tag>");
			process.exit(1);
		}
		console.log(renderTagMessage(tag));
	} else {
		const content = renderChangelog();
		writeFileSync(CHANGELOG_PATH, content, "utf-8");
		console.log(`Wrote ${CHANGELOG_PATH}`);
	}
}

main();
