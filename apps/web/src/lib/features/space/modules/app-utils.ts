import type { AppRecord, Permission } from "@neta-art/cohub";

export const APP_SCOPE_OPTIONS: {
	scope: Permission;
	label: string;
	description: string;
}[] = [
	{
		scope: "space.view",
		label: "View space",
		description: "Read basic Space metadata.",
	},
	{
		scope: "session.view",
		label: "View sessions",
		description: "Read session lists and details.",
	},
	{
		scope: "file.view",
		label: "View files",
		description: "Read workspace files.",
	},
	{
		scope: "file.edit",
		label: "Edit files",
		description: "Write and modify workspace files.",
	},
	{
		scope: "taskrun.view",
		label: "View task runs",
		description: "Read task run status and output.",
	},
	{
		scope: "session.prompt.readonly",
		label: "Prompt read-only",
		description: "Send read-only prompts in sessions.",
	},
	{
		scope: "session.prompt.fullaccess",
		label: "Prompt full access",
		description: "Send prompts with full agent access.",
	},
	{
		scope: "command.execute",
		label: "Run commands",
		description: "Execute sandbox commands.",
	},
];

/** Direct publisher grants stay deliberately small in v1. */
export const APP_SCOPE_GROUPS: {
	title: string;
	scopes: Permission[];
}[] = [
	{
		title: "App access",
		scopes: APP_SCOPE_OPTIONS.map((option) => option.scope),
	},
];

export function scopeState(
	scopes: Permission[],
	options: { scope: Permission }[],
) {
	const selected = new Set(scopes);
	return Object.fromEntries(
		options.map((option) => [option.scope, selected.has(option.scope)]),
	);
}

export function selectedScopeList(
	state: Record<string, boolean>,
	options: { scope: Permission }[],
) {
	return options.map((option) => option.scope).filter((scope) => state[scope]);
}

export function appStatusTone(status: AppRecord["status"]) {
	if (status === "published") return "text-status-running";
	if (status === "disabled") return "text-error-soft";
	return "text-text-tertiary";
}
