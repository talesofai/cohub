import type { Permission, WorkRecord } from "@neta-art/cohub";

export const WORK_SCOPE_OPTIONS: {
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
		scope: "taskrun.view",
		label: "View task runs",
		description: "Read task run status and output.",
	},
];

export const WORK_VIEWER_SCOPE_OPTIONS: {
	scope: Permission;
	label: string;
	description: string;
}[] = [
	{
		scope: "session.prompt.readonly",
		label: "Prompt read-only",
		description:
			"Allow read-only prompts and polling replies from viewer-owned sessions in this space.",
	},
	{
		scope: "session.prompt.fullaccess",
		label: "Prompt full access",
		description:
			"Allow prompt writes and reading replies from viewer-owned sessions in this space.",
	},
	{
		scope: "generation.create",
		label: "Create generations",
		description: "Allow viewers to start generation tasks.",
	},
	{
		scope: "user.space.list",
		label: "List viewer spaces",
		description: "Let the work list spaces the viewer owns or belongs to.",
	},
	{
		scope: "user.session.list",
		label: "List viewer sessions",
		description:
			"Let the work list sessions the viewer created across all spaces.",
	},
	{
		scope: "user.usage.read",
		label: "Read viewer usage",
		description: "Let the work read the viewer's aggregated usage and cost.",
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

export function workStatusTone(status: WorkRecord["status"]) {
	if (status === "published") return "text-status-running";
	if (status === "disabled") return "text-error-soft";
	return "text-text-tertiary";
}
