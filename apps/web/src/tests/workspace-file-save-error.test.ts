import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceFileSaveBlockMessage } from "$lib/features/space/modules/workspace-file-save-error";

test("workspace lease errors are not presented as file content conflicts", () => {
	assert.equal(
		workspaceFileSaveBlockMessage(409, "workspace_lease_busy"),
		"Workspace is currently controlled by another Agent.",
	);
	assert.equal(
		workspaceFileSaveBlockMessage(403, "workspace_write_disabled"),
		"Cloud file editing is disabled by workspace policy.",
	);
	assert.equal(
		workspaceFileSaveBlockMessage(409, "workspace_not_ready"),
		"Workspace is syncing. Retry shortly.",
	);
	assert.equal(workspaceFileSaveBlockMessage(409, "file_conflict"), null);
});
