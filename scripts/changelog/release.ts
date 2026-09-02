#!/usr/bin/env tsx
/**
 * Release orchestrator: generate changelog entry -> render -> commit -> annotated tag.
 *
 * Usage: tsx scripts/changelog/release.ts v1.99.0
 */

import { execFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateEntry, tagToVersion, upsertEntry } from "./generate.ts";
import { ENTRIES_PATH } from "./shared.ts";

function git(args: string[]): string {
	return execFileSync("git", args, { encoding: "utf-8" }).trim();
}

function run(cmd: string, args: string[]): void {
	execFileSync(cmd, args, { stdio: "inherit" });
}

async function main() {
	const tag = process.argv[2];
	if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
		console.error("Usage: tsx scripts/changelog/release.ts v<major>.<minor>.<patch>");
		process.exit(1);
	}

	if (git(["status", "--porcelain"])) {
		console.error("Working tree is not clean. Commit or stash changes first.");
		process.exit(1);
	}

	if (git(["tag", "-l", tag])) {
		console.error(`Tag ${tag} already exists.`);
		process.exit(1);
	}

	const prevTag = git(["describe", "--tags", "--abbrev=0", "--match", "v*"]);
	console.log(`Releasing ${tag} (previous: ${prevTag})`);

	// 1. Generate entry via agent (fails here if cohub CLI is missing)
	const entry = await generateEntry(prevTag, "HEAD");
	entry.tags = [tag];
	entry.version = tagToVersion(tag);
	upsertEntry(entry);

	// 2. Render CHANGELOG.md
	run("tsx", ["scripts/changelog/render.ts"]);

	// 3. Commit
	run("git", ["add", ENTRIES_PATH, "CHANGELOG.md"]);
	run("git", ["commit", "-m", `docs: changelog for ${tag}`]);

	// 4. Annotated tag with the entry as message
	const message = execFileSync(
		"tsx",
		["scripts/changelog/render.ts", "--tag", tag],
		{ encoding: "utf-8" },
	);
	const msgFile = join(process.cwd(), ".git", `TAG_MSG_${tag}`);
	writeFileSync(msgFile, message, "utf-8");
	try {
		run("git", ["tag", "-a", tag, "-F", msgFile]);
	} finally {
		unlinkSync(msgFile);
	}

	console.log(`\nDone. Review the changelog commit, then push:\n  git push && git push origin ${tag}`);
}

main().catch((error) => {
	console.error(String(error));
	process.exit(1);
});
