export function workspaceFileSaveBlockMessage(
	status: number,
	code: string | null,
): string | null {
	if (status !== 403 && status !== 409) return null;
	if (code === "workspace_lease_busy") {
		return "Workspace is currently controlled by another Agent.";
	}
	if (code === "workspace_write_disabled") {
		return "Cloud file editing is disabled by workspace policy.";
	}
	if (code === "workspace_not_ready" || code === "workspace_lease_lost") {
		return "Workspace is syncing. Retry shortly.";
	}
	return null;
}
