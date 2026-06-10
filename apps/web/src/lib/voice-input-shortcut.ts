export type VoiceInputShortcut = {
	key: string;
	code: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	fnKey: boolean;
};

const STORAGE_KEY = "cohub:voice-input:push-to-talk-shortcut";
const CHANGE_EVENT = "cohub:voice-input-shortcut-changed";

const MODIFIER_KEYS = new Set([
	"alt",
	"control",
	"ctrl",
	"meta",
	"shift",
	"fn",
]);

function isBrowser() {
	return typeof window !== "undefined";
}

function isMacPlatform() {
	if (!isBrowser()) return false;
	const nav = navigator as Navigator & {
		userAgentData?: { platform?: string };
	};
	const platform = nav.userAgentData?.platform || navigator.platform || "";
	return /mac|iphone|ipad|ipod/i.test(platform);
}

function normalizeKey(value: string | undefined) {
	const key = (value || "").trim();
	if (!key) return "";
	if (key === " ") return "space";
	const lower = key.toLowerCase();
	if (lower === "control") return "ctrl";
	if (lower === "escape") return "esc";
	if (lower === "arrowup") return "up";
	if (lower === "arrowdown") return "down";
	if (lower === "arrowleft") return "left";
	if (lower === "arrowright") return "right";
	return key.length === 1 ? lower : lower;
}

function normalizeCode(value: string | undefined) {
	return (value || "").trim();
}

function isModifierKey(key: string) {
	return MODIFIER_KEYS.has(key);
}

function getEventFnState(event: KeyboardEvent, key: string) {
	return key === "fn" || event.getModifierState?.("Fn") === true;
}

function getEventShortcut(event: KeyboardEvent): VoiceInputShortcut {
	const key = normalizeKey(event.key);
	return {
		key,
		code: normalizeCode(event.code),
		ctrlKey: event.ctrlKey || key === "ctrl",
		metaKey: event.metaKey || key === "meta",
		altKey: event.altKey || key === "alt",
		shiftKey: event.shiftKey || key === "shift",
		fnKey: getEventFnState(event, key),
	};
}

function modifierCount(shortcut: VoiceInputShortcut) {
	return [
		shortcut.ctrlKey,
		shortcut.metaKey,
		shortcut.altKey,
		shortcut.shiftKey,
		shortcut.fnKey,
	].filter(Boolean).length;
}

export function getDefaultVoiceInputShortcut(): VoiceInputShortcut {
	if (isMacPlatform()) {
		return {
			key: "shift",
			code: "ShiftLeft",
			ctrlKey: false,
			metaKey: false,
			altKey: false,
			shiftKey: true,
			fnKey: true,
		};
	}
	return {
		key: "h",
		code: "KeyH",
		ctrlKey: true,
		metaKey: false,
		altKey: false,
		shiftKey: false,
		fnKey: false,
	};
}

export function normalizeVoiceInputShortcut(
	input: unknown,
): VoiceInputShortcut | null {
	if (!input || typeof input !== "object") return null;
	const record = input as Partial<VoiceInputShortcut>;
	const key = normalizeKey(record.key);
	if (!key) return null;
	const shortcut: VoiceInputShortcut = {
		key,
		code: normalizeCode(record.code),
		ctrlKey: record.ctrlKey === true,
		metaKey: record.metaKey === true,
		altKey: record.altKey === true,
		shiftKey: record.shiftKey === true,
		fnKey: record.fnKey === true,
	};
	if (!isModifierKey(shortcut.key) || modifierCount(shortcut) > 0) {
		return shortcut;
	}
	return null;
}

export function readVoiceInputShortcut() {
	if (!isBrowser()) return getDefaultVoiceInputShortcut();
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return getDefaultVoiceInputShortcut();
		return (
			normalizeVoiceInputShortcut(JSON.parse(raw)) ??
			getDefaultVoiceInputShortcut()
		);
	} catch {
		return getDefaultVoiceInputShortcut();
	}
}

function emitShortcutChanged(shortcut: VoiceInputShortcut) {
	if (!isBrowser()) return;
	window.dispatchEvent(
		new CustomEvent<VoiceInputShortcut>(CHANGE_EVENT, { detail: shortcut }),
	);
}

export function writeVoiceInputShortcut(shortcut: VoiceInputShortcut) {
	const normalized =
		normalizeVoiceInputShortcut(shortcut) ?? getDefaultVoiceInputShortcut();
	if (!isBrowser()) return normalized;
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
	} catch {
		// Keep the in-memory value usable when storage is blocked.
	}
	emitShortcutChanged(normalized);
	return normalized;
}

export function resetVoiceInputShortcut() {
	const next = getDefaultVoiceInputShortcut();
	if (isBrowser()) {
		try {
			window.localStorage.removeItem(STORAGE_KEY);
		} catch {
			// Ignore storage failures.
		}
	}
	emitShortcutChanged(next);
	return next;
}

export function listenVoiceInputShortcutChange(
	callback: (shortcut: VoiceInputShortcut) => void,
) {
	if (!isBrowser()) return () => undefined;
	const onCustom = (event: Event) => {
		const shortcut = (event as CustomEvent<VoiceInputShortcut>).detail;
		const normalized = normalizeVoiceInputShortcut(shortcut);
		if (normalized) callback(normalized);
	};
	const onStorage = (event: StorageEvent) => {
		if (event.key !== STORAGE_KEY) return;
		callback(readVoiceInputShortcut());
	};
	window.addEventListener(CHANGE_EVENT, onCustom);
	window.addEventListener("storage", onStorage);
	return () => {
		window.removeEventListener(CHANGE_EVENT, onCustom);
		window.removeEventListener("storage", onStorage);
	};
}

function keyMatchesEvent(event: KeyboardEvent, shortcut: VoiceInputShortcut) {
	const key = normalizeKey(event.key);
	if (key === shortcut.key) return true;
	if (shortcut.code && event.code === shortcut.code) return true;
	return false;
}

function modifiersMatch(event: KeyboardEvent, shortcut: VoiceInputShortcut) {
	const key = normalizeKey(event.key);
	return (
		(event.ctrlKey || key === "ctrl") === shortcut.ctrlKey &&
		(event.metaKey || key === "meta") === shortcut.metaKey &&
		(event.altKey || key === "alt") === shortcut.altKey &&
		(event.shiftKey || key === "shift") === shortcut.shiftKey &&
		getEventFnState(event, key) === shortcut.fnKey
	);
}

export function isVoiceInputShortcutTrigger(
	event: KeyboardEvent,
	shortcut: VoiceInputShortcut,
) {
	return keyMatchesEvent(event, shortcut) && modifiersMatch(event, shortcut);
}

export function isVoiceInputShortcutRelease(
	event: KeyboardEvent,
	shortcut: VoiceInputShortcut,
) {
	const key = normalizeKey(event.key);
	if (keyMatchesEvent(event, shortcut)) return true;
	if (shortcut.ctrlKey && key === "ctrl") return true;
	if (shortcut.metaKey && key === "meta") return true;
	if (shortcut.altKey && key === "alt") return true;
	if (shortcut.shiftKey && key === "shift") return true;
	if (shortcut.fnKey && key === "fn") return true;
	return false;
}

export function voiceInputShortcutFromKeyboardEvent(
	event: KeyboardEvent,
	options: { allowSingleModifier?: boolean } = {},
) {
	const shortcut = getEventShortcut(event);
	if (
		isModifierKey(shortcut.key) &&
		modifierCount(shortcut) <= 1 &&
		!options.allowSingleModifier
	) {
		return null;
	}
	return normalizeVoiceInputShortcut(shortcut);
}

function formatKey(key: string) {
	if (key.length === 1) return key.toUpperCase();
	if (key === "ctrl") return "Ctrl";
	if (key === "meta") return isMacPlatform() ? "Cmd" : "Meta";
	if (key === "alt") return "Alt";
	if (key === "shift") return "Shift";
	if (key === "fn") return "Fn";
	if (key === "esc") return "Esc";
	if (key === "space") return "Space";
	return key.slice(0, 1).toUpperCase() + key.slice(1);
}

export function formatVoiceInputShortcut(shortcut: VoiceInputShortcut) {
	const parts: string[] = [];
	if (shortcut.fnKey) parts.push("Fn");
	if (shortcut.metaKey) parts.push(isMacPlatform() ? "Cmd" : "Meta");
	if (shortcut.ctrlKey) parts.push("Ctrl");
	if (shortcut.altKey) parts.push("Alt");
	if (shortcut.shiftKey) parts.push("Shift");
	if (!isModifierKey(shortcut.key)) parts.push(formatKey(shortcut.key));
	return parts.length > 0 ? parts.join("+") : formatKey(shortcut.key);
}
