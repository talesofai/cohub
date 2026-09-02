#!/usr/bin/env tsx
/**
 * Generate a changelog entry for a tag range by asking a Cohub agent
 * to analyze the actual code diffs (not just commit messages).
 *
 * Usage: tsx scripts/changelog/generate.ts --from v1.97.1 --to v1.98.0
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	AgentResponseSchema,
	ENTRIES_PATH,
	type ChangelogEntry,
	readEntries,
	writeEntries,
} from "./shared.ts";

const MAX_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

function buildPrompt(fromTag: string, toTag: string): string {
	return `Run git diff --stat and git diff between ${fromTag} and ${toTag} to see actual code changes. Write a changelog entry for Cohub (a technical product with engineering brand).

Include:
- User/developer-facing features, UX/performance improvements
- Significant refactors, architecture changes, stack upgrades (important for technical brand)
- Notable bug fixes in optional "fixes" array

Exclude: dependency bumps, typos, CI tweaks.

2-5 highlights. Lead important items with bold noun phrase: "**Feature name**: description". English only.

Reply with ONLY this JSON:
\`\`\`json
{"highlights":["...","..."],"fixes":["..."]}
\`\`\``;
}

const RETRY_PROMPT = (error: string) =>
	`Your previous reply failed validation: ${error}
Reply again with ONLY a JSON code block matching:
{ "highlights": ["1-6 non-empty strings"], "fixes": ["optional strings"] }`;

function cohub(args: string[]): string {
	return execFileSync("cohub", args, { encoding: "utf-8" });
}

function git(args: string[]): string {
	return execFileSync("git", args, { encoding: "utf-8" }).trim();
}

/** Entry version from a tag: "v2.31.0" -> "2.31"; a bare "X.Y" passes through. */
export function tagToVersion(tag: string): string {
	return tag.replace(/^v/, "").replace(/^(\d+\.\d+)\.\d+$/, "$1");
}

function requireCohubCli(): void {
	try {
		execFileSync("cohub", ["--version"], { stdio: "ignore" });
	} catch {
		console.error(
			"cohub CLI not found. Install it first: npm install -g @neta-art/cohub-cli",
		);
		process.exit(1);
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PromptResult {
	sessionId: string;
	text: string;
}

async function promptAgent(
	message: string,
	sessionId?: string,
): Promise<PromptResult> {
	const args = ["spaces", "prompt", "--json"];
	if (sessionId) args.push("--session", sessionId);
	args.push(message);

	const sent = JSON.parse(cohub(args));
	const sid: string = sent.session.id;
	const turnId: string = sent.turn.id;

	const deadline = Date.now() + POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await sleep(POLL_INTERVAL_MS);
		const { turn } = JSON.parse(
			cohub(["spaces", "sessions", "turns", "get", "--json", sid, turnId]),
		);
		if (turn.status === "completed") {
			if (!turn.assistantText) throw new Error("turn completed with no text");
			return { sessionId: sid, text: turn.assistantText };
		}
		if (turn.status === "failed" || turn.status === "cancelled") {
			throw new Error(
				`turn ${turn.status}: ${turn.errorMessage ?? "unknown error"}`,
			);
		}
	}
	throw new Error(`turn timed out after ${POLL_TIMEOUT_MS / 60_000} minutes`);
}

function extractJson(text: string): unknown {
	const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const raw = block ? block[1] : text.match(/\{[\s\S]*\}/)?.[0];
	if (!raw) throw new Error("no JSON found in response");
	return JSON.parse(raw.trim());
}

function saveDraft(toTag: string, text: string): string {
	const path = join(process.cwd(), ".changelog-draft", `${toTag}.md`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text, "utf-8");
	return path;
}

export async function generateEntry(
	fromTag: string,
	toTag: string,
): Promise<ChangelogEntry> {
	let message = buildPrompt(fromTag, toTag);
	let sessionId: string | undefined;
	let lastText = "";

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		console.log(
			`Asking agent to analyze ${fromTag}..${toTag} (attempt ${attempt}/${MAX_ATTEMPTS})...`,
		);
		const result = await promptAgent(message, sessionId);
		sessionId = result.sessionId;
		lastText = result.text;

		const parsed = AgentResponseSchema.safeParse(
			(() => {
				try {
					return extractJson(result.text);
				} catch (error) {
					return { __parseError: String(error) };
				}
			})(),
		);

		if (parsed.success) {
			const date = git(["log", "-1", "--format=%as", toTag]);
			return {
				version: tagToVersion(toTag),
				date,
				tags: [toTag],
				highlights: parsed.data.highlights,
				...(parsed.data.fixes?.length ? { fixes: parsed.data.fixes } : {}),
			};
		}

		const error = parsed.error.issues
			.map((i) => `${i.path.join(".")}: ${i.message}`)
			.join("; ");
		console.warn(`Validation failed: ${error}`);
		message = RETRY_PROMPT(error);
	}

	const draftPath = saveDraft(toTag, lastText);
	throw new Error(
		`failed after ${MAX_ATTEMPTS} attempts; raw response saved to ${draftPath}`,
	);
}

/** Insert or update an entry. If version exists, replaces content and merges tags. */
export function upsertEntry(entry: ChangelogEntry): void {
	const entries = readEntries();
	const existing = entries.findIndex((e) => e.version === entry.version);
	if (existing >= 0) {
		entry.tags = [...new Set([...entries[existing].tags, ...entry.tags])];
		entries[existing] = entry;
	} else {
		entries.push(entry);
	}
	const byVersion = (v: string) => v.split(".").map(Number);
	entries.sort((a, b) => {
		const [amaj, amin] = byVersion(a.version);
		const [bmaj, bmin] = byVersion(b.version);
		return bmaj - amaj || bmin - amin;
	});
	writeEntries(entries);
	console.log(`Wrote v${entry.version} to ${ENTRIES_PATH}`);
}

async function main() {
	const args = process.argv.slice(2);
	const arg = (name: string) => {
		const i = args.indexOf(name);
		return i >= 0 ? args[i + 1] : undefined;
	};
	const fromTag = arg("--from");
	const toTag = arg("--to");
	if (!fromTag || !toTag) {
		console.error(
			"Usage: tsx scripts/changelog/generate.ts --from <tag> --to <tag>",
		);
		process.exit(1);
	}
	if (toTag === "HEAD") {
		console.error(
			"--to HEAD is only supported via changelog:release, which knows the target tag.",
		);
		process.exit(1);
	}

	requireCohubCli();
	const entry = await generateEntry(fromTag, toTag);
	upsertEntry(entry);
	console.log(JSON.stringify(entry, null, 2));
}

const isDirectRun = process.argv[1]?.includes("generate.ts");
if (isDirectRun) {
	main().catch((error) => {
		console.error(String(error));
		process.exit(1);
	});
}
