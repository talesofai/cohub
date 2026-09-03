import type {
	CreateGenerationTaskRequest,
	GenerationContentBlock,
	PublicGenerationDeclaration,
} from "@cohub/protocol/generation";
import type { TaskRunRecord } from "@neta-art/cohub";
import type {
	BoardFrame,
	BoardItem,
	BoardTaskArtifact,
	BoardTaskSnapshot,
} from "@neta-art/cohub/board";

export type BoardGenerationMediaType = "image" | "video" | "audio";

export type BoardGenerationReference = {
	id: string;
	type: BoardGenerationMediaType;
	url: string;
	label: string;
	role?: string;
};

export type BoardGenerationValidationInputType =
	| "text"
	| BoardGenerationMediaType;

export type BoardGenerationValidationError =
	| { code: "model_required" }
	| { code: "audio_reference_required"; model: string }
	| { code: "metadata_required"; model: string }
	| { code: "references_unsupported"; model: string }
	| { code: "text_unsupported"; model: string }
	| {
			code: "input_required";
			inputType: BoardGenerationValidationInputType;
			model: string;
	  }
	| {
			code: "input_minimum";
			inputType: BoardGenerationValidationInputType;
			min: number;
			model: string;
	  }
	| {
			code: "input_maximum";
			inputType: BoardGenerationValidationInputType;
			max: number;
			model: string;
	  }
	| {
			code: "reference_role_required";
			inputType: BoardGenerationMediaType;
	  }
	| {
			code: "reference_role_invalid";
			inputType: BoardGenerationMediaType;
	  }
	| { code: "prompt_minimum_characters"; min: number; model: string }
	| { code: "input_missing" }
	| { code: "parameter_required"; parameter: string }
	| { code: "parameter_text_required"; parameter: string }
	| { code: "parameter_option_invalid"; parameter: string }
	| {
			code: "parameter_dimensions_format";
			parameter: string;
			separator: string;
	  }
	| { code: "parameter_minimum"; parameter: string; min: number }
	| { code: "parameter_maximum"; parameter: string; max: number }
	| {
			code: "parameter_multiple";
			parameter: string;
			multipleOf: number;
	  }
	| { code: "parameter_boolean_required"; parameter: string }
	| {
			code: "parameter_number_invalid";
			parameter: string;
			valueType: "number" | "integer";
	  };

const REGENERATED_TASK_GAP = 48;
const PENDING_TASK_WIDTH = 300;

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function isGenerationContentBlock(
	value: unknown,
): value is GenerationContentBlock {
	const block = record(value);
	if (!block) return false;
	if (block.meta !== undefined && !record(block.meta)) return false;
	if (block.type === "text") return typeof block.text === "string";
	if (
		block.type !== "image" &&
		block.type !== "video" &&
		block.type !== "audio"
	)
		return false;
	const source = record(block.source);
	if (source?.type === "url") return typeof source.url === "string";
	return (
		source?.type === "base64" &&
		typeof source.mediaType === "string" &&
		typeof source.data === "string"
	);
}

/** Rebuild a public generation request from an authoritative TaskRun detail. */
export function regenerationRequestFromTaskRun(
	run: TaskRunRecord,
	spaceId: string,
): CreateGenerationTaskRequest {
	if (run.taskType !== "generation" || run.spaceId !== spaceId) {
		throw new Error("This task cannot be regenerated on this board.");
	}
	const payload = record(run.payload);
	const data = record(payload?.data) ?? payload;
	const model = data?.model;
	const content = data?.content;
	const parameters = data?.parameters;
	const meta = data?.meta;
	if (
		typeof model !== "string" ||
		!model.trim() ||
		!Array.isArray(content) ||
		content.length === 0 ||
		!content.every(isGenerationContentBlock) ||
		(parameters !== undefined && !record(parameters)) ||
		(meta !== undefined && !record(meta))
	) {
		throw new Error("The original generation input is unavailable.");
	}
	return {
		spaceId,
		model,
		content,
		...(parameters === undefined
			? {}
			: { parameters: parameters as Record<string, unknown> }),
		...(meta === undefined ? {} : { meta: meta as Record<string, unknown> }),
	};
}

export function generationPromptFromContent(
	content: readonly GenerationContentBlock[],
): string {
	const block = content.find((candidate) => candidate.type === "text");
	return block?.type === "text" ? block.text : "";
}

/** Center a pending task node to the right of its source with a stable gap. */
export function regeneratedTaskPosition(source: BoardFrame) {
	return {
		x: source.x + source.width + REGENERATED_TASK_GAP + PENDING_TASK_WIDTH / 2,
		y: source.y + source.height / 2,
	};
}

const QWEN_REFERENCE_VOICE_MODELS = new Set([
	"qwen-tts",
	"qwen-audio-3.0-tts-plus",
	"qwen-audio-3.0-tts-flash",
]);
const QWEN_AUDIO_3_MODELS = new Set([
	"qwen-audio-3.0-tts-plus",
	"qwen-audio-3.0-tts-flash",
]);

export function normalizeGenerationReferenceUrl(value: string): string | null {
	try {
		const url = new URL(value.trim());
		return url.protocol === "https:" || url.protocol === "http:"
			? value.trim()
			: null;
	} catch {
		return null;
	}
}

const TASK_ARTIFACT_REFERENCE_SEP = "::artifact:";

function isGenerationMediaArtifact(
	artifact: BoardTaskArtifact,
): artifact is Extract<BoardTaskArtifact, { type: BoardGenerationMediaType }> {
	return (
		artifact.type === "image" ||
		artifact.type === "video" ||
		artifact.type === "audio"
	);
}

/** Recover the board node id from a generation-reference id. */
export function generationReferenceSourceItemId(referenceId: string): string {
	const index = referenceId.indexOf(TASK_ARTIFACT_REFERENCE_SEP);
	return index === -1 ? referenceId : referenceId.slice(0, index);
}

function mediaItemGenerationLabel(item: BoardItem): string | null {
	if (
		item.type !== "image" &&
		item.type !== "video" &&
		item.type !== "audio" &&
		item.type !== "file"
	) {
		return null;
	}
	return (
		item.snapshot?.title ?? item.ref.path.split("/").pop() ?? item.ref.path
	);
}

function taskItemGenerationLabel(
	item: Extract<BoardItem, { type: "task" }>,
	artifact: Extract<BoardTaskArtifact, { type: BoardGenerationMediaType }>,
): string {
	const artifactTitle = artifact.title?.replace(/\s+/g, " ").trim();
	if (artifactTitle) return artifactTitle;
	const title = item.snapshot.title.replace(/\s+/g, " ").trim();
	if (title) return title;
	const excerpt = item.snapshot.promptExcerpt?.replace(/\s+/g, " ").trim();
	if (excerpt) return excerpt;
	return item.snapshot.model?.trim() || item.id;
}

/**
 * Map a completed generation task's image/video/audio artifacts to composer
 * references. Pending, failed, non-generation, and unusable URLs are skipped.
 */
export function generationReferencesFromTaskItem(
	item: BoardItem,
): BoardGenerationReference[] {
	if (item.type !== "task") return [];
	const { snapshot } = item;
	if (snapshot.taskType !== "generation" || snapshot.status !== "completed") {
		return [];
	}
	return snapshot.artifacts.flatMap((artifact) => {
		if (!isGenerationMediaArtifact(artifact)) return [];
		const url = normalizeGenerationReferenceUrl(artifact.url);
		if (!url) return [];
		return [
			{
				id: `${item.id}${TASK_ARTIFACT_REFERENCE_SEP}${artifact.id}`,
				type: artifact.type,
				url,
				label: taskItemGenerationLabel(item, artifact),
			},
		];
	});
}

/** True when the selection toolbar/menu should offer "Add to generation". */
export function canAddBoardItemToGeneration(item: BoardItem): boolean {
	if (item.type === "image" || item.type === "video" || item.type === "audio") {
		return true;
	}
	return generationReferencesFromTaskItem(item).length > 0;
}

/**
 * Sync artifact/media mapping used by tests and the composer. Plain media
 * nodes need a resolved http(s) URL; task artifacts use their snapshot URL.
 */
export function collectBoardGenerationReferences(
	items: readonly BoardItem[],
	resolvedMediaUrls: Readonly<Record<string, string>> = {},
): BoardGenerationReference[] {
	return items.flatMap((item) => {
		if (item.type === "task") return generationReferencesFromTaskItem(item);
		if (
			item.type !== "image" &&
			item.type !== "video" &&
			item.type !== "audio"
		) {
			return [];
		}
		const raw = resolvedMediaUrls[item.id];
		if (!raw) return [];
		const url = normalizeGenerationReferenceUrl(raw);
		if (!url) return [];
		return [
			{
				id: item.id,
				type: item.type,
				url,
				label: mediaItemGenerationLabel(item) ?? item.id,
			},
		];
	});
}

export function parseBoardGenerationReferences(
	value: unknown,
): BoardGenerationReference[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((candidate) => {
		if (!candidate || typeof candidate !== "object") return [];
		const reference = candidate as Record<string, unknown>;
		const url =
			typeof reference.url === "string"
				? normalizeGenerationReferenceUrl(reference.url)
				: null;
		if (
			typeof reference.id !== "string" ||
			(reference.type !== "image" &&
				reference.type !== "video" &&
				reference.type !== "audio") ||
			!url ||
			typeof reference.label !== "string"
		) {
			return [];
		}
		const role =
			typeof reference.role === "string" && reference.role.trim()
				? reference.role.trim()
				: undefined;
		return [
			{
				id: reference.id,
				type: reference.type,
				url,
				label: reference.label,
				...(role ? { role } : {}),
			},
		];
	});
}

export function generationInputSpec(
	model: PublicGenerationDeclaration,
	type: "text" | BoardGenerationMediaType,
) {
	return model.content.input.find((spec) => spec.type === type) ?? null;
}

export function supportsBoardGenerationComposer(
	model: PublicGenerationDeclaration,
	references: readonly BoardGenerationReference[] = [],
): boolean {
	if (
		Object.values(model.meta?.fields ?? {}).some(
			(spec) => spec.optional !== true,
		)
	) {
		return false;
	}
	return (
		!QWEN_REFERENCE_VOICE_MODELS.has(model.model) ||
		references.some((reference) => reference.type === "audio")
	);
}

export function modelAcceptsGenerationReferences(
	model: PublicGenerationDeclaration,
	references: readonly BoardGenerationReference[],
): boolean {
	for (const type of ["image", "video", "audio"] as const) {
		const count = references.filter(
			(reference) => reference.type === type,
		).length;
		if (count === 0) continue;
		const spec = generationInputSpec(model, type);
		if (!spec || (typeof spec.max === "number" && count > spec.max))
			return false;
		if (spec.sources && !spec.sources.includes("url")) return false;
	}
	return true;
}

export function defaultGenerationReferenceRole(
	model: PublicGenerationDeclaration,
	type: BoardGenerationMediaType,
): string | undefined {
	const spec = generationInputSpec(model, type);
	return spec?.roleRequired ? spec.roles?.[0] : undefined;
}

function generationModelName(model: PublicGenerationDeclaration): string {
	return model.title?.trim() || model.model;
}

export function validateBoardGeneration(input: {
	model: PublicGenerationDeclaration | null;
	prompt: string;
	references: readonly BoardGenerationReference[];
}): BoardGenerationValidationError | null {
	const { model, references } = input;
	if (!model) return { code: "model_required" };
	const modelName = generationModelName(model);
	if (!supportsBoardGenerationComposer(model, references)) {
		return QWEN_REFERENCE_VOICE_MODELS.has(model.model)
			? { code: "audio_reference_required", model: modelName }
			: { code: "metadata_required", model: modelName };
	}
	if (!modelAcceptsGenerationReferences(model, references)) {
		return { code: "references_unsupported", model: modelName };
	}

	const textCount = input.prompt.trim() ? 1 : 0;
	if (textCount > 0 && !generationInputSpec(model, "text")) {
		return { code: "text_unsupported", model: modelName };
	}
	for (const spec of model.content.input) {
		const count =
			spec.type === "text"
				? textCount
				: references.filter((reference) => reference.type === spec.type).length;
		if (spec.required === true && count === 0) {
			return {
				code: "input_required",
				inputType: spec.type,
				model: modelName,
			};
		}
		if (typeof spec.min === "number" && count < spec.min) {
			return {
				code: "input_minimum",
				inputType: spec.type,
				min: spec.min,
				model: modelName,
			};
		}
		if (typeof spec.max === "number" && count > spec.max) {
			return {
				code: "input_maximum",
				inputType: spec.type,
				max: spec.max,
				model: modelName,
			};
		}
		if (
			spec.roleRequired &&
			spec.type !== "text" &&
			references.some(
				(reference) => reference.type === spec.type && !reference.role,
			)
		) {
			return {
				code: "reference_role_required",
				inputType: spec.type,
			};
		}
		if (
			spec.type !== "text" &&
			spec.roles &&
			references.some(
				(reference) =>
					reference.type === spec.type &&
					reference.role !== undefined &&
					!spec.roles?.includes(reference.role),
			)
		) {
			return {
				code: "reference_role_invalid",
				inputType: spec.type,
			};
		}
	}

	if (
		QWEN_AUDIO_3_MODELS.has(model.model) &&
		Array.from(input.prompt.trim()).length < 15
	) {
		return {
			code: "prompt_minimum_characters",
			min: 15,
			model: modelName,
		};
	}
	if (textCount === 0 && references.length === 0)
		return { code: "input_missing" };
	return null;
}

export function validateBoardGenerationParameters(
	model: PublicGenerationDeclaration | null,
	parameters: Readonly<Record<string, unknown>>,
): BoardGenerationValidationError | null {
	if (!model) return null;
	for (const [name, spec] of Object.entries(model.parameters ?? {})) {
		const parameter = name.replaceAll("_", " ");
		const value = parameters[name];
		if (value === undefined) {
			if (spec.default === undefined && spec.optional !== true) {
				return { code: "parameter_required", parameter };
			}
			continue;
		}
		if (spec.type === "string") {
			if (typeof value !== "string")
				return { code: "parameter_text_required", parameter };
			if (spec.enum && !spec.enum.includes(value)) {
				return { code: "parameter_option_invalid", parameter };
			}
			if (spec.dimensions) {
				const { min, max, multipleOf, separator = "x" } = spec.dimensions;
				const parts = value.split(separator);
				if (parts.length !== 2 || parts.some((part) => !/^\d+$/.test(part))) {
					return {
						code: "parameter_dimensions_format",
						parameter,
						separator,
					};
				}
				const dimensions = parts.map(Number);
				if (
					min !== undefined &&
					dimensions.some((dimension) => dimension < min)
				) {
					return { code: "parameter_minimum", parameter, min };
				}
				if (
					max !== undefined &&
					dimensions.some((dimension) => dimension > max)
				) {
					return { code: "parameter_maximum", parameter, max };
				}
				if (
					multipleOf !== undefined &&
					dimensions.some((dimension) => dimension % multipleOf !== 0)
				) {
					return {
						code: "parameter_multiple",
						parameter,
						multipleOf,
					};
				}
			}
			continue;
		}
		if (spec.type === "boolean") {
			if (typeof value !== "boolean")
				return { code: "parameter_boolean_required", parameter };
			continue;
		}
		if (
			typeof value !== "number" ||
			!Number.isFinite(value) ||
			(spec.type === "integer" && !Number.isInteger(value))
		) {
			return {
				code: "parameter_number_invalid",
				parameter,
				valueType: spec.type,
			};
		}
		if (spec.min !== undefined && value < spec.min) {
			return {
				code: "parameter_minimum",
				parameter,
				min: spec.min,
			};
		}
		if (spec.max !== undefined && value > spec.max) {
			return {
				code: "parameter_maximum",
				parameter,
				max: spec.max,
			};
		}
	}
	return null;
}

export function buildBoardGenerationContent(
	prompt: string,
	references: readonly BoardGenerationReference[],
): GenerationContentBlock[] {
	const content: GenerationContentBlock[] = [];
	const text = prompt.trim();
	if (text) content.push({ type: "text", text });
	for (const reference of references) {
		content.push({
			type: reference.type,
			source: { type: "url", url: reference.url },
			...(reference.role ? { meta: { role: reference.role } } : {}),
		});
	}
	return content;
}

export function pendingGenerationTaskSnapshot(input: {
	prompt: string;
	model: string;
	now?: string;
}): BoardTaskSnapshot {
	const prompt = input.prompt.replace(/\s+/g, " ").trim();
	const excerpt = prompt.slice(0, 480);
	return {
		taskType: "generation",
		status: "pending",
		title: excerpt.slice(0, 240) || "Media generation",
		model: input.model,
		...(excerpt ? { promptExcerpt: excerpt } : {}),
		artifactCount: 0,
		artifacts: [],
		updatedAt: input.now ?? new Date().toISOString(),
	};
}
