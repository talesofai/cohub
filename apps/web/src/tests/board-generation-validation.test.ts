import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicGenerationDeclaration } from "@cohub/protocol/generation";
import type { BoardGenerationValidationError } from "../lib/board/board-generation.ts";
import { validateBoardGeneration } from "../lib/board/board-generation.ts";
import { formatBoardGenerationValidationError } from "../lib/board/board-generation-validation-message.ts";

const validationErrors = [
	{ code: "model_required" },
	{ code: "audio_reference_required", model: "Voice Model" },
	{ code: "metadata_required", model: "Advanced Model" },
	{ code: "references_unsupported", model: "Text Model" },
	{ code: "text_unsupported", model: "Image Model" },
	{ code: "input_required", inputType: "text", model: "Video Model" },
	{
		code: "input_minimum",
		inputType: "image",
		min: 2,
		model: "Image Model",
	},
	{
		code: "input_maximum",
		inputType: "video",
		max: 3,
		model: "Video Model",
	},
	{ code: "reference_role_required", inputType: "audio" },
	{ code: "reference_role_invalid", inputType: "image" },
	{
		code: "prompt_minimum_characters",
		min: 15,
		model: "Voice Model",
	},
	{ code: "input_missing" },
	{ code: "parameter_required", parameter: "duration" },
	{ code: "parameter_text_required", parameter: "aspect ratio" },
	{ code: "parameter_option_invalid", parameter: "resolution" },
	{
		code: "parameter_dimensions_format",
		parameter: "size",
		separator: "x",
	},
	{ code: "parameter_minimum", parameter: "duration", min: 4 },
	{ code: "parameter_maximum", parameter: "duration", max: 15 },
	{
		code: "parameter_multiple",
		parameter: "width",
		multipleOf: 8,
	},
	{ code: "parameter_boolean_required", parameter: "watermark" },
	{
		code: "parameter_number_invalid",
		parameter: "frames per second",
		valueType: "integer",
	},
] satisfies readonly BoardGenerationValidationError[];

test("every board generation validation code has English and Chinese copy", () => {
	for (const error of validationErrors) {
		for (const locale of ["en", "zh-CN"] as const) {
			const message = formatBoardGenerationValidationError(error, locale);
			assert.ok(message.trim(), `${error.code} is empty for ${locale}`);
		}
	}
});

test("a required Seedance-like text prompt names the selected model", () => {
	const model: PublicGenerationDeclaration = {
		schema: "neta.generation.model.v1",
		model: "seedance-like",
		title: "Seedance Example",
		content: {
			input: [
				{ type: "text", required: true, min: 1 },
				{
					type: "image",
					required: false,
					max: 9,
					sources: ["url"],
					roles: ["first_frame", "last_frame", "reference_image"],
				},
			],
		},
	};
	const issue = validateBoardGeneration({
		model,
		prompt: "",
		references: [
			{
				id: "image-1",
				type: "image",
				url: "https://example.com/frame.png",
				label: "First frame",
				role: "first_frame",
			},
		],
	});

	assert.ok(issue);
	assert.deepEqual(issue, {
		code: "input_required",
		inputType: "text",
		model: "Seedance Example",
	});
	assert.equal(
		formatBoardGenerationValidationError(issue, "en"),
		"Seedance Example requires a text prompt.",
	);
	assert.equal(
		formatBoardGenerationValidationError(issue, "zh-CN"),
		"Seedance Example 需要文字描述才能开始生成。",
	);
});
