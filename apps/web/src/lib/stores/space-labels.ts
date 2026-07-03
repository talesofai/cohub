import type {
	LabelAssignmentListItem,
	LabelAssignmentPageInfo,
	LabelAssignmentRecord,
	LabelListItem,
	LabelResourceType,
} from "@neta-art/cohub";
import { labelItemsRepo } from "$lib/cache/repositories/label-items-repo";
import { labelTreeRepo } from "$lib/cache/repositories/label-tree-repo";
import { resourceLabelsRepo } from "$lib/cache/repositories/resource-labels-repo";
import { userProfilesRepo } from "$lib/cache/repositories/user-profiles-repo";
import { sdk } from "$lib/sdk";

const LABEL_ITEMS_PAGE_SIZE = 30;
const SESSION_USER_LABEL_SYSTEM_KEY_PREFIX = "session-user:";
function fallbackUserName(userUuid: string) {
	return userUuid.replaceAll("-", "").slice(0, 8) || "User";
}

export function getSessionUserUuidFromLabel(label: LabelListItem) {
	const systemKey = label.systemKey?.trim() ?? "";
	if (systemKey.startsWith(SESSION_USER_LABEL_SYSTEM_KEY_PREFIX)) {
		const userUuid = systemKey
			.slice(SESSION_USER_LABEL_SYSTEM_KEY_PREFIX.length)
			.trim();
		return userUuid && userUuid !== "root" ? userUuid : null;
	}
	return null;
}

export function isSessionUserLabel(label: LabelListItem) {
	return Boolean(getSessionUserUuidFromLabel(label));
}

export function getLabelDisplayName(label: LabelListItem) {
	if (label.systemKey === `${SESSION_USER_LABEL_SYSTEM_KEY_PREFIX}root`)
		return "User";
	const userUuid = getSessionUserUuidFromLabel(label);
	if (!userUuid) return label.name;
	return (
		userProfilesRepo.getSync(userUuid)?.displayName?.trim() ||
		fallbackUserName(userUuid)
	);
}

export function getLabelDisplayTitle(label: LabelListItem) {
	if (label.systemKey === `${SESSION_USER_LABEL_SYSTEM_KEY_PREFIX}root`)
		return label.name === "User" ? "User" : `${label.name} · User`;
	const userUuid = getSessionUserUuidFromLabel(label);
	if (!userUuid) return label.name;
	const profile = userProfilesRepo.getSync(userUuid);
	return [
		profile?.displayName?.trim() || fallbackUserName(userUuid),
		profile?.username ? `@${profile.username}` : null,
		userUuid,
	]
		.filter(Boolean)
		.join(" · ");
}

export function getLabelUserProfile(label: LabelListItem) {
	const userUuid = getSessionUserUuidFromLabel(label);
	return userUuid ? userProfilesRepo.getSync(userUuid) : null;
}

export function onUserLabelProfilesUpdated(handler: () => void) {
	return userProfilesRepo.subscribe(() => handler());
}

function collectSessionUserUuids(labels: LabelListItem[]) {
	const userUuids = new Set<string>();
	const visit = (items: LabelListItem[]) => {
		for (const label of items) {
			const userUuid = getSessionUserUuidFromLabel(label);
			if (userUuid) userUuids.add(userUuid);
			if (label.children?.length) visit(label.children);
		}
	};
	visit(labels);
	return [...userUuids];
}

export async function hydrateUserProfilesForLabels(labels: LabelListItem[]) {
	await userProfilesRepo.hydrate(collectSessionUserUuids(labels));
}

function queueHydrateUserLabelProfiles(labels: LabelListItem[]) {
	void hydrateUserProfilesForLabels(labels).catch(() => undefined);
}

export async function getCachedSpaceLabelsSnapshot(spaceId: string) {
	return labelTreeRepo.get(spaceId);
}

export async function getCachedSpaceLabels(spaceId: string) {
	const labels = (await labelTreeRepo.get(spaceId))?.labels ?? null;
	if (labels) queueHydrateUserLabelProfiles(labels);
	return labels;
}

export async function setCachedSpaceLabels(
	spaceId: string,
	labels: LabelListItem[],
) {
	queueHydrateUserLabelProfiles(labels);
	return (await labelTreeRepo.set(spaceId, labels)).labels;
}

export function onSpaceLabelsCacheUpdated(
	handler: (event: { spaceId: string; labels: LabelListItem[] }) => void,
) {
	if (typeof window === "undefined") return () => {};
	const listener = (event: Event) => {
		const custom = event as CustomEvent<{
			spaceId: string;
			labels: LabelListItem[];
		}>;
		if (!custom.detail?.spaceId || !Array.isArray(custom.detail.labels)) return;
		handler(custom.detail);
	};
	window.addEventListener("cohub:space-labels-updated", listener);
	return () =>
		window.removeEventListener("cohub:space-labels-updated", listener);
}

export async function fetchSpaceLabelsFresh(spaceId: string) {
	const labels = (await sdk.space(spaceId).labels.list()).labels ?? [];
	queueHydrateUserLabelProfiles(labels);
	return (await labelTreeRepo.set(spaceId, labels, { source: "network" }))
		.labels;
}

export async function fetchSpaceLabels(spaceId: string, force = false) {
	if (!force) {
		const cached = await labelTreeRepo.get(spaceId);
		if (cached && !cached.stale) {
			queueHydrateUserLabelProfiles(cached.labels);
			return cached.labels;
		}
	}
	return fetchSpaceLabelsFresh(spaceId);
}

export type LabelWithRef = LabelListItem & { ref: string };

export function flattenLabelsWithRefs(labels: LabelListItem[]) {
	const result: LabelWithRef[] = [];
	const visit = (items: LabelListItem[], parentRef = "") => {
		for (const label of items) {
			const ref = parentRef ? `${parentRef}/${label.name}` : label.name;
			result.push({ ...label, ref });
			if (label.children?.length) visit(label.children, ref);
		}
	};
	visit(labels);
	return result;
}

export async function getLabelRefById(spaceId: string, labelId: string) {
	const labels = await fetchSpaceLabels(spaceId);
	return (
		flattenLabelsWithRefs(labels).find((label) => label.id === labelId)?.ref ??
		null
	);
}

export async function getLabelByRef(spaceId: string, labelRef: string) {
	const labels = await fetchSpaceLabels(spaceId);
	return (
		flattenLabelsWithRefs(labels).find((label) => label.ref === labelRef) ??
		null
	);
}

export function getLabelRefsFromAssignments(
	labels: LabelListItem[],
	assignments: LabelAssignmentRecord[],
) {
	const refsById = new Map(
		flattenLabelsWithRefs(labels).map((label) => [label.id, label.ref]),
	);
	return assignments
		.map((assignment) => refsById.get(assignment.labelId))
		.filter((ref): ref is string => Boolean(ref));
}

export function getLabelIdsByRefs(labels: LabelListItem[], refs: string[]) {
	const idsByRef = new Map(
		flattenLabelsWithRefs(labels).map((label) => [label.ref, label.id]),
	);
	return refs
		.map((ref) => idsByRef.get(ref))
		.filter((id): id is string => Boolean(id));
}

export function flattenLabels(labels: LabelListItem[]) {
	const result: LabelListItem[] = [];
	const visit = (items: LabelListItem[]) => {
		for (const label of items) {
			result.push(label);
			if (label.children?.length) visit(label.children);
		}
	};
	visit(labels);
	return result;
}

export async function createSpaceLabel(spaceId: string, labelRef: string) {
	const result = await sdk.space(spaceId).labels.create(labelRef);
	await fetchSpaceLabelsFresh(spaceId);
	return result.labels[0] ?? null;
}

export async function deleteSpaceLabel(spaceId: string, labelRef: string) {
	const label = await getLabelByRef(spaceId, labelRef);
	await sdk.space(spaceId).labels.delete(labelRef);
	const labels = await fetchSpaceLabelsFresh(spaceId);
	if (label)
		await labelItemsRepo
			.deleteFirstPage(spaceId, label.id)
			.catch(() => undefined);
	return labels;
}

export async function getCachedResourceLabelsSnapshot(
	spaceId: string,
	resourceType: LabelResourceType,
	resourceRef: string,
) {
	return resourceLabelsRepo.get(spaceId, resourceType, resourceRef);
}

export async function getResourceLabels(
	spaceId: string,
	resourceType: LabelResourceType,
	resourceRef: string,
) {
	const result = await sdk
		.space(spaceId)
		.labels.getResourceLabels(resourceType, resourceRef);
	await Promise.all([
		labelTreeRepo.set(spaceId, result.labels, { source: "network" }),
		resourceLabelsRepo.set(spaceId, resourceType, resourceRef, result, {
			source: "network",
		}),
	]);
	queueHydrateUserLabelProfiles(result.labels);
	return result;
}

export async function fetchResourceLabelsFresh(
	spaceId: string,
	resourceType: LabelResourceType,
	resourceRef: string,
) {
	return getResourceLabels(spaceId, resourceType, resourceRef);
}

export async function fetchResourceLabels(
	spaceId: string,
	resourceType: LabelResourceType,
	resourceRef: string,
	force = false,
) {
	if (!force) {
		const cached = await getCachedResourceLabelsSnapshot(
			spaceId,
			resourceType,
			resourceRef,
		);
		if (cached && !cached.stale) {
			queueHydrateUserLabelProfiles(cached.labels);
			return {
				labels: cached.labels,
				assignments: cached.assignments,
				fromCache: true,
			} as const;
		}
	}
	return getResourceLabels(spaceId, resourceType, resourceRef).then(
		(result) => ({ ...result, fromCache: false }) as const,
	);
}

export async function getCachedLabelItemsSnapshot(
	spaceId: string,
	labelId: string,
) {
	return labelItemsRepo.getFirstPage(spaceId, labelId);
}

export async function fetchLabelItemsFirstPageFresh(
	spaceId: string,
	labelId: string,
	labelRef?: string,
) {
	const ref = labelRef ?? (await getLabelRefById(spaceId, labelId));
	if (!ref)
		return { items: [], pageInfo: { hasMore: false, nextCursor: null } };
	const snapshot = await labelItemsRepo.refreshFirstPage(
		spaceId,
		labelId,
		async () => {
			const result = await sdk.space(spaceId).labels.listItems(ref, {
				limit: LABEL_ITEMS_PAGE_SIZE,
				cursor: null,
			});
			return {
				items: result.items ?? [],
				pageInfo: result.pageInfo,
			};
		},
	);
	return { items: snapshot.items, pageInfo: snapshot.pageInfo };
}

export async function setCachedLabelItemsFirstPage(
	spaceId: string,
	labelId: string,
	input: {
		items: LabelAssignmentListItem[];
		pageInfo?: LabelAssignmentPageInfo | null;
	},
) {
	return labelItemsRepo.setFirstPage(spaceId, labelId, input);
}

export async function markLabelItemsStale(spaceId: string, labelId: string) {
	return labelItemsRepo.markStale(spaceId, labelId);
}

async function cacheResourceLabelMutation(input: {
	spaceId: string;
	resourceType: LabelResourceType;
	resourceRef: string;
	result: { labels: LabelListItem[]; assignments: LabelAssignmentRecord[] };
	affectedRefs: string[];
}) {
	await Promise.all([
		labelTreeRepo.set(input.spaceId, input.result.labels, {
			source: "network",
		}),
		resourceLabelsRepo.set(
			input.spaceId,
			input.resourceType,
			input.resourceRef,
			input.result,
			{ source: "network" },
		),
	]);
	queueHydrateUserLabelProfiles(input.result.labels);

	const affectedLabelIds = getLabelIdsByRefs(
		input.result.labels,
		input.affectedRefs,
	);
	await Promise.all(
		affectedLabelIds.map((labelId) =>
			markLabelItemsStale(input.spaceId, labelId),
		),
	).catch(() => undefined);

	if (typeof window !== "undefined") {
		window.dispatchEvent(
			new CustomEvent("cohub:label-assignments-updated", {
				detail: {
					spaceId: input.spaceId,
					resourceType: input.resourceType,
					resourceRef: input.resourceRef,
					affectedLabelIds,
				},
			}),
		);
	}
}

export async function patchResourceLabels(
	spaceId: string,
	resourceType: LabelResourceType,
	resourceRef: string,
	input: { addLabelRefs?: string[]; removeLabelRefs?: string[] },
): Promise<{
	labels: LabelListItem[];
	assignments: LabelAssignmentRecord[];
	changed: boolean;
}> {
	const result = await sdk
		.space(spaceId)
		.labels.patchResourceLabels(resourceType, resourceRef, input);
	await cacheResourceLabelMutation({
		spaceId,
		resourceType,
		resourceRef,
		result,
		affectedRefs: result.changed
			? [...(input.addLabelRefs ?? []), ...(input.removeLabelRefs ?? [])]
			: [],
	});
	return result;
}

export async function setResourceLabels(
	spaceId: string,
	resourceType: LabelResourceType,
	resourceRef: string,
	labelRefs: string[],
	options?: { previousLabelRefs?: string[] },
): Promise<{ labels: LabelListItem[]; assignments: LabelAssignmentRecord[] }> {
	const previousLabelRefs =
		options?.previousLabelRefs ??
		(await getResourceLabels(spaceId, resourceType, resourceRef)
			.then((result) =>
				getLabelRefsFromAssignments(result.labels, result.assignments),
			)
			.catch(() => undefined));
	const result = await sdk
		.space(spaceId)
		.labels.setResourceLabels(resourceType, resourceRef, labelRefs);
	await cacheResourceLabelMutation({
		spaceId,
		resourceType,
		resourceRef,
		result,
		affectedRefs: previousLabelRefs
			? Array.from(new Set([...previousLabelRefs, ...labelRefs]))
			: labelRefs,
	});
	return result;
}

export { LABEL_ITEMS_PAGE_SIZE };
