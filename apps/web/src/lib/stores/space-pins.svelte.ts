import { invalidatePaletteOverview } from "$lib/command-palette/palette-overview";
import { sdk } from "$lib/sdk";
import { authStore } from "$lib/stores/auth.svelte";
import {
	getCachedSpaceList,
	patchCachedSpaceList,
} from "$lib/stores/space-list-cache";

/**
 * Space pin store — manages optimistic pin/unpin and multi-client sync.
 *
 * Pin state rides on `SpaceRecord.isPinned` in the space list cache, so the
 * space picker reads it directly with no extra fetch. Toggles are optimistic;
 * failures roll back precisely. Realtime `label.assignments.updated` events
 * (delivered to the user room) refresh the cached `isPinned` flag when another
 * tab/device mutates the user's labels.
 */

const PINNED_LABEL_REF = "Pinned";
let realtimeBound = false;

/** Subscribe to user-room realtime events for pin sync. Call once at app init. */
export function initSpacePinRealtime() {
	if (realtimeBound || typeof window === "undefined") return;
	realtimeBound = true;
	sdk.onUserEvent((event) => {
		if (event.type !== "label.assignments.updated") return;
		const payload = event.payload as {
			resourceType?: string;
			resourceRef?: string;
		};
		if (payload.resourceType !== "space" || !payload.resourceRef) return;
		void refreshPinnedState(payload.resourceRef);
	});
}

async function refreshPinnedState(spaceId: string) {
	try {
		const result = await sdk.user.labels.getResourceLabels("space", spaceId);
		const isPinned = result.assignments.some(
			(a) => a.labelSystemKey === "user:pinned",
		);
		setPinnedInCache(spaceId, isPinned);
		invalidatePaletteOverview();
	} catch {
		// Non-critical: the next list refetch will reconcile.
	}
}

function setPinnedInCache(spaceId: string, isPinned: boolean) {
	patchCachedSpaceList((spaces) =>
		spaces.map((s) => (s.id === spaceId ? { ...s, isPinned } : s)),
	);
}

export async function toggleSpacePin(spaceId: string): Promise<void> {
	await authStore.ensureLoaded();
	const current = getCachedSpaceList() ?? [];
	const space = current.find((s) => s.id === spaceId);
	const wasPinned = space?.isPinned ?? false;

	// Optimistic update. The overview snapshot contains pin state too.
	setPinnedInCache(spaceId, !wasPinned);
	invalidatePaletteOverview();

	try {
		await sdk.user.labels.patchResourceLabels(
			"space",
			spaceId,
			wasPinned
				? { removeLabelRefs: [PINNED_LABEL_REF] }
				: { addLabelRefs: [PINNED_LABEL_REF] },
		);
	} catch (error) {
		// Rollback on failure; keep the overview invalidated so the next read
		// reconciles against the server.
		setPinnedInCache(spaceId, wasPinned);
		invalidatePaletteOverview();
		throw error;
	}
}
