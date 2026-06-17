import type { TaskRunRecord } from "@neta-art/cohub";

const STORAGE_KEY = "cohub:desktop-task-notifications:v1";
const DEDUPE_LIMIT = 500;

export type DesktopTaskNotificationStatus = "unsupported" | NotificationPermission;

export type DesktopTaskNotificationPreferences = {
	enabled: boolean;
	notifyCompleted: boolean;
	notifyFailed: boolean;
};

export type DesktopTaskNotificationTask = Partial<TaskRunRecord> & {
	id: string;
	type?: string | null;
	userId?: string | null;
};

const DEFAULT_PREFERENCES: DesktopTaskNotificationPreferences = {
	enabled: false,
	notifyCompleted: true,
	notifyFailed: true,
};

const notifiedTaskKeys: string[] = [];
const notifiedTaskKeySet = new Set<string>();

function isBrowser() {
	return typeof window !== "undefined";
}

export function getDesktopTaskNotificationStatus(): DesktopTaskNotificationStatus {
	if (!isBrowser() || !("Notification" in window)) return "unsupported";
	return Notification.permission;
}

function readPreferences(): DesktopTaskNotificationPreferences {
	if (!isBrowser()) return { ...DEFAULT_PREFERENCES };
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULT_PREFERENCES };
		const parsed = JSON.parse(raw) as Partial<DesktopTaskNotificationPreferences>;
		return {
			enabled: parsed.enabled === true,
			notifyCompleted: parsed.notifyCompleted !== false,
			notifyFailed: parsed.notifyFailed !== false,
		};
	} catch {
		return { ...DEFAULT_PREFERENCES };
	}
}

function writePreferences(preferences: DesktopTaskNotificationPreferences) {
	if (!isBrowser()) return;
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
	} catch {
		// localStorage can be unavailable; runtime permission remains authoritative.
	}
}

export function getDesktopTaskNotificationPreferences() {
	return readPreferences();
}

export function setDesktopTaskNotificationPreferences(
	patch: Partial<DesktopTaskNotificationPreferences>,
) {
	const next = { ...readPreferences(), ...patch };
	writePreferences(next);
	return next;
}

export async function requestDesktopTaskNotificationPermission() {
	if (getDesktopTaskNotificationStatus() === "unsupported") return "unsupported";
	const permission = await Notification.requestPermission();
	setDesktopTaskNotificationPreferences({ enabled: permission === "granted" });
	return permission;
}

function remember(key: string) {
	if (notifiedTaskKeySet.has(key)) return false;
	notifiedTaskKeySet.add(key);
	notifiedTaskKeys.push(key);
	while (notifiedTaskKeys.length > DEDUPE_LIMIT) {
		const stale = notifiedTaskKeys.shift();
		if (stale) notifiedTaskKeySet.delete(stale);
	}
	return true;
}

function taskTypeLabel(task: DesktopTaskNotificationTask) {
	return (task.type ?? task.taskType ?? "task").replaceAll("_", " ");
}

function notificationBody(task: DesktopTaskNotificationTask) {
	const type = taskTypeLabel(task);
	if (task.status === "failed") {
		const message = task.errorMessage?.trim();
		return message ? `${type} failed: ${message}` : `${type} failed`;
	}
	return `${type} completed`;
}

export function notifyTaskFinished(task: DesktopTaskNotificationTask) {
	if (getDesktopTaskNotificationStatus() !== "granted") return false;
	const preferences = readPreferences();
	if (!preferences.enabled) return false;
	if (task.status === "completed" && !preferences.notifyCompleted) return false;
	if (task.status === "failed" && !preferences.notifyFailed) return false;
	if (task.status !== "completed" && task.status !== "failed") return false;

	const key = `${task.id}:${task.status}:${task.finishedAt ?? task.updatedAt ?? ""}`;
	if (!remember(key)) return false;

	const notification = new Notification(
		task.status === "failed" ? "Cohub task failed" : "Cohub task completed",
		{
			body: notificationBody(task),
			tag: `cohub-task-${task.id}-${task.status}`,
			requireInteraction: true,
		},
	);
	notification.onclick = () => {
		window.focus();
	};
	return true;
}
