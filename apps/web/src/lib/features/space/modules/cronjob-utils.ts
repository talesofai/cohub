import { MAX_PROMPT_SYSTEM_INSTRUCTIONS_LENGTH } from "@cohub/protocol";
import type { CronJobRecord, CronJobUpdatePatch } from "@neta-art/cohub";
import type { ModelThinkingLevel } from "$lib/model-catalog";
import { asRecord } from "../space-utils";

export type CronjobSelectedModel = {
	provider: string;
	id: string;
	name?: string;
	thinkingLevel?: ModelThinkingLevel | null;
};

export function formatContentBlockForPreview(block: unknown): string {
	const record = asRecord(block);
	if (!record)
		return typeof block === "string" ? block : JSON.stringify(block, null, 2);
	if (record.type === "text" && typeof record.text === "string") {
		return record.text;
	}
	if (record.type === "thinking" && typeof record.thinking === "string") {
		return `[thinking]\n${record.thinking}`;
	}
	if (record.type === "image") return "[image attachment]";
	if (record.type === "tool_use" && typeof record.name === "string") {
		return `[tool use: ${record.name}]\n${JSON.stringify(record.input ?? {}, null, 2)}`;
	}
	if (record.type === "tool_result") return "[tool result]";
	return JSON.stringify(record, null, 2);
}

export function cronjobPayloadContent(payload: unknown): unknown {
	return asRecord(payload)?.content;
}

export function formatCronjobPrompt(payload: unknown): string {
	const content = cronjobPayloadContent(payload);
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const preview = content
			.map(formatContentBlockForPreview)
			.map((part) => part.trim())
			.filter(Boolean)
			.join("\n\n");
		return preview || JSON.stringify(content, null, 2);
	}
	if (content !== undefined) return JSON.stringify(content, null, 2);
	return "—";
}

export function cronjobPromptMeta(payload: unknown): string {
	const content = cronjobPayloadContent(payload);
	if (Array.isArray(content)) {
		const textLength = content.reduce((sum, block) => {
			const record = asRecord(block);
			return sum + (typeof record?.text === "string" ? record.text.length : 0);
		}, 0);
		return `${content.length} block${content.length === 1 ? "" : "s"}${textLength ? ` · ${textLength} chars` : ""}`;
	}
	if (typeof content === "string") return `${content.length} chars`;
	return "Payload content";
}

export function cronjobPayloadField(payload: unknown, key: string): string {
	const value = asRecord(payload)?.[key];
	if (typeof value === "string" && value.trim()) return value;
	return "—";
}

export function promptTextFromPayload(payload: unknown): {
	text: string;
	structured: boolean;
} {
	const content = cronjobPayloadContent(payload);
	if (typeof content === "string") return { text: content, structured: false };
	if (Array.isArray(content)) {
		if (content.length === 1) {
			const block = asRecord(content[0]);
			if (block?.type === "text" && typeof block.text === "string") {
				return { text: block.text, structured: false };
			}
		}
		return { text: formatCronjobPrompt(payload), structured: true };
	}
	return { text: "", structured: false };
}

export function buildSendMessagePayload(
	originalPayload: unknown,
	prompt: string,
	model: CronjobSelectedModel | null,
) {
	const next: Record<string, unknown> = {
		...(asRecord(originalPayload) ?? {}),
		content: [{ type: "text", text: prompt.trim() }],
	};
	if (model) {
		next.provider = model.provider;
		next.model = model.id;
		if (model.thinkingLevel) next.thinkingLevel = model.thinkingLevel;
		else delete next.thinkingLevel;
	} else {
		delete next.provider;
		delete next.model;
		delete next.thinkingLevel;
	}
	return next;
}

export function applySystemInstructionsUpdate(
	payload: Record<string, unknown>,
	replacement: string,
	clear: boolean,
) {
	const next = { ...payload };
	if (clear) {
		next.systemInstructions = null;
		return next;
	}
	const normalized = replacement.trim();
	if (normalized) next.systemInstructions = normalized;
	return next;
}

export function buildPromptSystemInstructionsInput(value: string) {
	const systemInstructions = value.trim();
	return systemInstructions ? { systemInstructions } : {};
}

export function cronjobModelLabel(model: CronjobSelectedModel | null) {
	if (!model) return "Default model";
	return model.name?.trim() || model.id;
}

export function defaultTimezone() {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, nested]) => nested !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(
				([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function buildCronjobUpdatePatch(input: {
	detail: CronJobRecord;
	title: string;
	cronExpression: string;
	timezone: string;
	payload: Record<string, unknown>;
}): CronJobUpdatePatch {
	const title = input.title.trim();
	const cronExpression = input.cronExpression.trim();
	const timezone = input.timezone.trim();
	return {
		expectedUpdatedAt: input.detail.updatedAt,
		...(title !== input.detail.title ? { title } : {}),
		...(cronExpression !== input.detail.cronExpression
			? { cronExpression }
			: {}),
		...(timezone !== input.detail.timezone ? { timezone } : {}),
		...(stableStringify(input.payload) !== stableStringify(input.detail.payload)
			? { payload: input.payload }
			: {}),
	};
}

export function validateCronjobForm(input: {
	title: string;
	cronExpression: string;
	timezone: string;
	prompt: string;
	systemInstructions?: string;
}) {
	if (!input.title.trim()) return "Title is required";
	if (!input.cronExpression.trim()) return "Cron expression is required";
	if (!input.timezone.trim()) return "Timezone is required";
	if (!input.prompt.trim()) return "Prompt message is required";
	if (
		(input.systemInstructions?.trim().length ?? 0) >
		MAX_PROMPT_SYSTEM_INSTRUCTIONS_LENGTH
	) {
		return `Turn instructions must be ${MAX_PROMPT_SYSTEM_INSTRUCTIONS_LENGTH.toLocaleString()} characters or fewer`;
	}
	const cronParts = input.cronExpression.trim().split(/\s+/);
	if (cronParts.length !== 5) {
		return "Invalid cron expression format. Expected 5 fields, e.g. 0 9 * * *.";
	}
	return "";
}
