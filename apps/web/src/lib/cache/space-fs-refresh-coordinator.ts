export type SpaceFsRefreshBatch = {
	eventSpaceId: string;
	sourceKey: string;
	generation: number;
	resync: boolean;
	dirs: Set<string>;
	boardManifestPaths: Set<string>;
	inlineFilePaths: Set<string>;
};

type Lane = {
	pending: SpaceFsRefreshBatch | null;
	running: boolean;
};

type CoordinatorState = {
	lanes: Map<string, Lane>;
};

function batchKey(batch: SpaceFsRefreshBatch) {
	return `${batch.generation}\0${batch.eventSpaceId}\0${batch.sourceKey}`;
}

function mergeSets(left: Set<string>, right: Set<string>) {
	return new Set([...left, ...right]);
}

function mergeBatches(
	current: SpaceFsRefreshBatch | null,
	next: SpaceFsRefreshBatch,
): SpaceFsRefreshBatch {
	if (!current) return next;
	const resync = current.resync || next.resync;
	return {
		...next,
		resync,
		dirs: resync ? new Set() : mergeSets(current.dirs, next.dirs),
		boardManifestPaths: resync
			? new Set()
			: mergeSets(current.boardManifestPaths, next.boardManifestPaths),
		inlineFilePaths: resync
			? new Set()
			: mergeSets(current.inlineFilePaths, next.inlineFilePaths),
	};
}

export function createSpaceFsRefreshCoordinator(
	refresh: (batch: SpaceFsRefreshBatch) => Promise<void>,
	onError: (error: unknown) => void,
) {
	let state: CoordinatorState = { lanes: new Map() };

	async function drainLane(owner: CoordinatorState, key: string, lane: Lane) {
		lane.running = true;
		while (owner === state && lane.pending) {
			const batch = lane.pending;
			lane.pending = null;
			try {
				await refresh(batch);
			} catch (error) {
				onError(error);
			}
		}
		lane.running = false;
		if (owner === state && !lane.pending) owner.lanes.delete(key);
	}

	return {
		enqueue(batch: SpaceFsRefreshBatch) {
			const owner = state;
			const key = batchKey(batch);
			const lane = owner.lanes.get(key) ?? { pending: null, running: false };
			lane.pending = mergeBatches(lane.pending, batch);
			owner.lanes.set(key, lane);
			if (!lane.running) void drainLane(owner, key, lane);
		},
		reset() {
			state = { lanes: new Map() };
		},
	};
}
