import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	BoardFrame,
	BoardImageItem,
	BoardItem,
	BoardTaskArtifact,
	BoardTaskItem,
	BoardTaskSnapshot,
} from "@neta-art/cohub/board";
import {
	canAddBoardItemToGeneration,
	collectBoardGenerationReferences,
	generationReferenceSourceItemId,
	generationReferencesFromTaskItem,
} from "../lib/board/board-generation.ts";

const frame: BoardFrame = {
	x: 0,
	y: 0,
	width: 300,
	height: 180,
	rotation: 0,
};

function imageArtifact(
	id: string,
	url: string,
	title?: string,
): Extract<BoardTaskArtifact, { type: "image" }> {
	return {
		id,
		type: "image",
		url,
		...(title ? { title } : {}),
	};
}

function videoArtifact(
	id: string,
	url: string,
	previewUrl?: string,
): Extract<BoardTaskArtifact, { type: "video" }> {
	return {
		id,
		type: "video",
		url,
		...(previewUrl ? { previewUrl } : {}),
	};
}

function taskItem(input: {
	id?: string;
	status?: BoardTaskSnapshot["status"];
	taskType?: string;
	title?: string;
	promptExcerpt?: string;
	artifacts?: BoardTaskSnapshot["artifacts"];
}): BoardTaskItem {
	const artifacts = input.artifacts ?? [];
	return {
		id: input.id ?? "task-1",
		type: "task",
		taskRunId: "run-1",
		frame,
		snapshot: {
			taskType: input.taskType ?? "generation",
			status: input.status ?? "completed",
			title: input.title ?? "A sunset over water",
			...(input.promptExcerpt ? { promptExcerpt: input.promptExcerpt } : {}),
			artifactCount: artifacts.length,
			artifacts,
			updatedAt: "2026-08-25T12:00:00.000Z",
		},
	};
}

function imageItem(id: string, path: string, title?: string): BoardImageItem {
	return {
		id,
		type: "image",
		ref: { kind: "space-file", path },
		...(title ? { snapshot: { title } } : {}),
		frame,
	};
}

test("completed generation image artifacts become typed references", () => {
	const item = taskItem({
		artifacts: [
			imageArtifact("output-1", "https://cdn.example.com/gpt-image.png"),
		],
	});
	const references = generationReferencesFromTaskItem(item);
	assert.deepEqual(references, [
		{
			id: "task-1::artifact:output-1",
			type: "image",
			url: "https://cdn.example.com/gpt-image.png",
			label: "A sunset over water",
		},
	]);
	assert.equal(canAddBoardItemToGeneration(item), true);
	assert.equal(
		generationReferenceSourceItemId(references[0]?.id ?? ""),
		"task-1",
	);
});

test("completed generation video artifacts use the playable URL, not the poster", () => {
	const item = taskItem({
		title: "A walking shot",
		artifacts: [
			videoArtifact(
				"clip-1",
				"https://cdn.example.com/minimax.mp4",
				"https://cdn.example.com/minimax-poster.jpg",
			),
		],
	});
	assert.deepEqual(generationReferencesFromTaskItem(item), [
		{
			id: "task-1::artifact:clip-1",
			type: "video",
			url: "https://cdn.example.com/minimax.mp4",
			label: "A walking shot",
		},
	]);
});

test("a task with multiple media artifacts yields one reference each", () => {
	const item = taskItem({
		artifacts: [
			imageArtifact("img-1", "https://cdn.example.com/a.png", "First still"),
			videoArtifact("vid-1", "https://cdn.example.com/b.mp4"),
			{
				id: "note-1",
				type: "text",
				textExcerpt: "ignored text output",
			},
		],
	});
	const references = generationReferencesFromTaskItem(item);
	assert.equal(references.length, 2);
	assert.deepEqual(
		references.map((reference) => [
			reference.type,
			reference.url,
			reference.label,
		]),
		[
			["image", "https://cdn.example.com/a.png", "First still"],
			["video", "https://cdn.example.com/b.mp4", "A sunset over water"],
		],
	);
});

test("pending, failed, and non-generation tasks never produce references", () => {
	const pending = taskItem({
		status: "pending",
		artifacts: [imageArtifact("a", "https://cdn.example.com/a.png")],
	});
	const failed = taskItem({
		status: "failed",
		artifacts: [imageArtifact("a", "https://cdn.example.com/a.png")],
	});
	const other = taskItem({
		taskType: "upscale",
		artifacts: [imageArtifact("a", "https://cdn.example.com/a.png")],
	});
	assert.deepEqual(generationReferencesFromTaskItem(pending), []);
	assert.deepEqual(generationReferencesFromTaskItem(failed), []);
	assert.deepEqual(generationReferencesFromTaskItem(other), []);
	assert.equal(canAddBoardItemToGeneration(pending), false);
	assert.equal(canAddBoardItemToGeneration(failed), false);
	assert.equal(canAddBoardItemToGeneration(other), false);
});

test("unusable artifact URLs are skipped without inventing a reference", () => {
	const item = taskItem({
		artifacts: [
			imageArtifact("blob", "blob:https://example.com/local"),
			imageArtifact("data", "data:image/png;base64,aaaa"),
			imageArtifact("relative", "/workspace/out.png"),
			imageArtifact("ok", "https://cdn.example.com/ok.png"),
		],
	});
	assert.deepEqual(generationReferencesFromTaskItem(item), [
		{
			id: "task-1::artifact:ok",
			type: "image",
			url: "https://cdn.example.com/ok.png",
			label: "A sunset over water",
		},
	]);
});

test("a completed task with only unusable artifacts hides add-to-generation", () => {
	const item = taskItem({
		artifacts: [
			{ id: "note", type: "text", textExcerpt: "hello" },
			imageArtifact("blob", "blob:https://example.com/local"),
		],
	});
	assert.deepEqual(generationReferencesFromTaskItem(item), []);
	assert.equal(canAddBoardItemToGeneration(item), false);
});

test("label prefers artifact title, then task title, then prompt excerpt", () => {
	const titled = taskItem({
		title: "Task title",
		promptExcerpt: "Prompt excerpt that is longer",
		artifacts: [
			imageArtifact("a", "https://cdn.example.com/a.png", "  Artifact name  "),
		],
	});
	assert.equal(
		generationReferencesFromTaskItem(titled)[0]?.label,
		"Artifact name",
	);

	const fromTitle = taskItem({
		title: "Task title",
		promptExcerpt: "Prompt excerpt",
		artifacts: [imageArtifact("a", "https://cdn.example.com/a.png")],
	});
	assert.equal(
		generationReferencesFromTaskItem(fromTitle)[0]?.label,
		"Task title",
	);

	const fromExcerpt = taskItem({
		title: "   ",
		promptExcerpt: "Prompt excerpt",
		artifacts: [imageArtifact("a", "https://cdn.example.com/a.png")],
	});
	assert.equal(
		generationReferencesFromTaskItem(fromExcerpt)[0]?.label,
		"Prompt excerpt",
	);
});

test("mixed selection maps plain media nodes and completed task artifacts", () => {
	const image = imageItem("img-node", "library/ref.png", "Workspace still");
	const pending = taskItem({
		id: "pending-task",
		status: "pending",
		artifacts: [imageArtifact("a", "https://cdn.example.com/pending.png")],
	});
	const completed = taskItem({
		id: "done-task",
		title: "Generated still",
		artifacts: [imageArtifact("out", "https://cdn.example.com/done.png")],
	});
	const references = collectBoardGenerationReferences(
		[image, pending, completed],
		{ "img-node": "https://cdn.example.com/workspace.png" },
	);
	assert.deepEqual(
		references.map((reference) => [
			reference.id,
			reference.type,
			reference.url,
			reference.label,
		]),
		[
			[
				"img-node",
				"image",
				"https://cdn.example.com/workspace.png",
				"Workspace still",
			],
			[
				"done-task::artifact:out",
				"image",
				"https://cdn.example.com/done.png",
				"Generated still",
			],
		],
	);
	assert.equal(canAddBoardItemToGeneration(image), true);
});

test("plain media without a resolvable URL is omitted from the mixed map", () => {
	const image = imageItem("img-node", "library/ref.png", "Workspace still");
	assert.deepEqual(collectBoardGenerationReferences([image], {}), []);
	assert.deepEqual(
		collectBoardGenerationReferences([image], {
			"img-node": "blob:https://example.com/x",
		}),
		[],
	);
});

test("non-media board items are ignored", () => {
	const text: BoardItem = {
		id: "text-1",
		type: "text",
		text: "hello",
		color: "neutral",
		fontSize: 24,
		frame,
	};
	assert.equal(canAddBoardItemToGeneration(text), false);
	assert.deepEqual(generationReferencesFromTaskItem(text), []);
	assert.deepEqual(collectBoardGenerationReferences([text]), []);
});
