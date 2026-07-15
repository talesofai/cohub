import type { CanvasSemanticOp } from "@neta-art/cohub";
import {
	type CanvasPendingTransactionCacheRecord,
	idbDelete,
	idbGetAllByIndex,
	idbPut,
} from "$lib/cache/db";
import { canvasPendingTransactionKey, getCacheUserKey } from "$lib/cache/keys";

export type CanvasPendingTransaction = {
	spaceId: string;
	documentId: string;
	txId: string;
	baseVersion: number | null;
	ops: CanvasSemanticOp[];
};

export async function writeCanvasPendingTransaction(
	input: CanvasPendingTransaction,
) {
	const userKey = getCacheUserKey();
	const now = Date.now();
	const key = canvasPendingTransactionKey(
		userKey,
		input.spaceId,
		input.documentId,
		input.txId,
	);
	const record: CanvasPendingTransactionCacheRecord = {
		key,
		userKey,
		spaceId: input.spaceId,
		documentId: input.documentId,
		txId: input.txId,
		baseVersion: input.baseVersion,
		ops: input.ops,
		attemptCount: 0,
		createdAt: now,
		updatedAt: now,
		lastAttemptAt: null,
	};
	await idbPut("canvas_pending_txs", record);
	return record;
}

export async function deleteCanvasPendingTransaction(input: {
	spaceId: string;
	documentId: string;
	txId: string;
}) {
	await idbDelete(
		"canvas_pending_txs",
		canvasPendingTransactionKey(
			getCacheUserKey(),
			input.spaceId,
			input.documentId,
			input.txId,
		),
	);
}

export async function listCanvasPendingTransactions(
	spaceId: string,
	documentId: string,
) {
	const rows = await idbGetAllByIndex<CanvasPendingTransactionCacheRecord>(
		"canvas_pending_txs",
		"by_user_space_document",
		IDBKeyRange.only([getCacheUserKey(), spaceId, documentId]),
	);
	return rows.sort((a, b) => a.createdAt - b.createdAt);
}

export async function markCanvasPendingTransactionAttempt(
	record: CanvasPendingTransactionCacheRecord,
) {
	await idbPut("canvas_pending_txs", {
		...record,
		attemptCount: record.attemptCount + 1,
		lastAttemptAt: Date.now(),
		updatedAt: Date.now(),
	});
}

export async function rebaseCanvasPendingTransaction(
	record: CanvasPendingTransactionCacheRecord,
	baseVersion: number,
) {
	const rebased = {
		...record,
		baseVersion,
		updatedAt: Date.now(),
	};
	await idbPut("canvas_pending_txs", rebased);
	return rebased;
}
