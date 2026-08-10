/**
 * One id per tab, surviving navigation and reconnects, so an agent started here
 * can address this tab later. A routing hint, never an authorization input.
 */

const STORAGE_KEY = "cohub:client-instance-id:v1";
const CHANNEL_NAME = "cohub:client-instance:v1";

type ClaimMessage = {
	type: "claim";
	clientId: string;
	claimedAt: number;
	nonce: string;
};

const isBrowser = () => typeof window !== "undefined";

function createId(): string {
	const raw = globalThis.crypto?.randomUUID?.();
	if (raw) return raw.replaceAll("-", "");
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`.padEnd(
		24,
		"0",
	);
}

function readStored(): string | null {
	try {
		const value = sessionStorage.getItem(STORAGE_KEY);
		return value && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null;
	} catch {
		return null;
	}
}

function writeStored(value: string) {
	try {
		sessionStorage.setItem(STORAGE_KEY, value);
	} catch {}
}

let clientId: string | null = null;
let channel: BroadcastChannel | null = null;
let claimedAt = 0;
let nonce = "";

function announce() {
	if (!channel || !clientId) return;
	channel.postMessage({
		type: "claim",
		clientId,
		claimedAt,
		nonce,
	} satisfies ClaimMessage);
}

function rotate() {
	clientId = createId();
	claimedAt = Date.now();
	nonce = createId();
	writeStored(clientId);
	announce();
}

/**
 * A duplicated tab inherits the id and would run the same command. The newcomer
 * cannot detect this alone, so an instance receiving a *later* claim for its own
 * id re-announces; that reply is what makes the newcomer rotate.
 */
function startDuplicateGuard() {
	if (channel || typeof BroadcastChannel === "undefined") return;
	channel = new BroadcastChannel(CHANNEL_NAME);
	channel.onmessage = (event: MessageEvent) => {
		const message = event.data as ClaimMessage | null;
		if (message?.type !== "claim" || message.clientId !== clientId) return;
		if (message.nonce === nonce) return;

		const theyClaimedLater =
			message.claimedAt > claimedAt ||
			(message.claimedAt === claimedAt && message.nonce > nonce);
		if (theyClaimedLater) {
			announce();
			return;
		}
		rotate();
	};
	announce();
}

export function getClientInstanceId(): string | null {
	if (!isBrowser()) return null;
	if (!clientId) {
		clientId = readStored() ?? createId();
		claimedAt = Date.now();
		nonce = createId();
		writeStored(clientId);
		startDuplicateGuard();
	}
	return clientId;
}

export function __resetClientInstanceForTests() {
	channel?.close();
	channel = null;
	clientId = null;
	claimedAt = 0;
	nonce = "";
}
