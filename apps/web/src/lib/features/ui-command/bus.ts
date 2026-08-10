import type { UiCommand, UiCommandDispatchedPayload } from "@neta-art/cohub";
import { getClientInstanceId } from "$lib/client-instance";

const loadSdk = async () => (await import("$lib/sdk")).sdk;

export type UiCommandOutcome =
	| { status: "pending" }
	| {
			status: "applied" | "ui_host_unavailable" | "rejected" | "unsupported";
			error?: { code: string; message: string };
	  };

export type UiCommandContext = {
	commandId: string;
	source: UiCommandDispatchedPayload["source"];
};

export type UiCommandHost = (
	command: UiCommand,
	context: UiCommandContext,
) => Promise<UiCommandOutcome>;

const HOST_UNAVAILABLE: UiCommandOutcome = {
	status: "ui_host_unavailable",
	error: {
		code: "ui_host_unavailable",
		message:
			"This Cohub tab is not showing a Space workspace that can host the preview.",
	},
};

let host: UiCommandHost | null = null;

/**
 * The entry exists before the command runs, so a redelivery does not execute it
 * twice, and the outcome is kept so a failed upload can be re-reported. In memory
 * by design: delivery is at-least-once, so callable methods should be repeatable.
 */
type TerminalUiCommandOutcome = Exclude<
	UiCommandOutcome,
	{ status: "pending" }
>;
type HandledEntry = {
	outcome: TerminalUiCommandOutcome | null;
	reported: boolean;
	accepted: boolean;
};
const handled = new Map<string, HandledEntry>();

const HANDLED_MAX = 200;
const HANDLED_KEEP = 100;
const UNREPORTED_MAX = 50;
const REPORT_ATTEMPTS = 3;
let reportRetryMs = 400;

/** A running command is never evicted, or a redelivery would run it again. */
function evictBounded() {
	let unreported = 0;
	for (const entry of handled.values()) {
		if (entry.outcome && !entry.reported) unreported += 1;
	}

	for (const [id, entry] of handled) {
		if (handled.size <= HANDLED_KEEP && unreported <= UNREPORTED_MAX) return;
		if (!entry.outcome && !entry.accepted) continue;
		if (entry.outcome && !entry.reported) {
			if (unreported <= UNREPORTED_MAX) continue;
			unreported -= 1;
		}
		handled.delete(id);
	}
}

function rememberBounded(commandId: string, entry: HandledEntry) {
	handled.set(commandId, entry);
	if (handled.size > HANDLED_MAX) evictBounded();
}

export function registerUiCommandHost(next: UiCommandHost): () => void {
	host = next;
	return () => {
		if (host === next) host = null;
	};
}

function isForThisClient(payload: UiCommandDispatchedPayload): boolean {
	const clientId = getClientInstanceId();
	return Boolean(clientId && payload.targetClientId === clientId);
}

export type UiCommandReporter = (
	commandId: string,
	body: {
		status: TerminalUiCommandOutcome["status"];
		error: { code: string; message: string } | null;
	},
) => Promise<unknown>;

let reporter: UiCommandReporter | null = null;

export function __setUiCommandReporterForTests(next: UiCommandReporter | null) {
	reporter = next;
}

export function getHandledSizeForTests(): number {
	return handled.size;
}

export function __resetUiCommandBusForTests(
	options: { retryMs?: number } = {},
) {
	handled.clear();
	reportRetryMs = options.retryMs ?? 400;
}

async function uploadResult(
	commandId: string,
	body: Parameters<UiCommandReporter>[1],
): Promise<unknown> {
	if (reporter) return reporter(commandId, body);
	const sdk = await loadSdk();
	return sdk.ui.reportResult(commandId, body);
}

async function report(
	commandId: string,
	outcome: TerminalUiCommandOutcome,
): Promise<boolean> {
	for (let attempt = 1; attempt <= REPORT_ATTEMPTS; attempt += 1) {
		try {
			await uploadResult(commandId, {
				status: outcome.status,
				error: outcome.error ?? null,
			});
			return true;
		} catch (error) {
			if (attempt === REPORT_ATTEMPTS) {
				console.warn("[ui-command] failed to report result", error);
				return false;
			}
			await new Promise((resolve) =>
				setTimeout(resolve, reportRetryMs * attempt),
			);
		}
	}
	return false;
}

export async function handleUiCommand(
	payload: UiCommandDispatchedPayload,
): Promise<void> {
	const seen = handled.get(payload.commandId);
	if (seen) {
		if (seen.outcome && !seen.reported) {
			seen.reported = await report(payload.commandId, seen.outcome);
		}
		return;
	}
	const entry: HandledEntry = {
		outcome: null,
		reported: false,
		accepted: false,
	};
	rememberBounded(payload.commandId, entry);

	let outcome: UiCommandOutcome;
	try {
		outcome = host
			? await host(payload.command, {
					commandId: payload.commandId,
					source: payload.source,
				})
			: HOST_UNAVAILABLE;
	} catch (error) {
		outcome = {
			status: "rejected",
			error: {
				code: "host_failed",
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}

	if (outcome.status === "pending") {
		// The Work acknowledged delivery and will settle this command directly.
		entry.accepted = true;
		return;
	}
	entry.outcome = outcome;
	entry.reported = await report(payload.commandId, outcome);
}

function parsePayload(value: unknown): UiCommandDispatchedPayload | null {
	if (!value || typeof value !== "object") return null;
	const payload = value as Partial<UiCommandDispatchedPayload>;
	if (typeof payload.commandId !== "string" || !payload.commandId) return null;
	if (typeof payload.targetClientId !== "string" || !payload.targetClientId)
		return null;
	if (!payload.command || typeof payload.command !== "object") return null;
	return payload as UiCommandDispatchedPayload;
}

let stopListening: (() => void) | null = null;

export function startUiCommandListener(): () => void {
	if (stopListening) return stopListening;
	let off: (() => void) | null = null;
	let cancelled = false;
	void loadSdk().then((sdk) => {
		if (cancelled) return;
		off = sdk.onUserEvent((event) => {
			if (event.type !== "ui.command.dispatched") return;
			const payload = parsePayload(event.payload);
			if (!payload || !isForThisClient(payload)) return;
			void handleUiCommand(payload);
		});
	});
	stopListening = () => {
		cancelled = true;
		off?.();
		stopListening = null;
	};
	return stopListening;
}
