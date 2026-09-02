import { isUuid } from "./identifiers.js";
import {
  NAVIGATION_ERROR_CODE_MAX_LENGTH,
  NAVIGATION_ERROR_MESSAGE_MAX_LENGTH,
  NAVIGATION_REF_MAX_LENGTH,
  NAVIGATION_METHOD_MAX_LENGTH,
  type NavigationCall,
  type NavigationLaunch,
} from "./navigation.js";

export const APP_NAVIGATION_PROTOCOL = "cohub.app.navigation";
export const APP_NAVIGATION_VERSION = 1;
export const APP_NAVIGATION_MAX_REF_LENGTH = NAVIGATION_REF_MAX_LENGTH;
export const APP_NAVIGATION_MAX_METHOD_LENGTH = NAVIGATION_METHOD_MAX_LENGTH;
export const APP_NAVIGATION_MAX_ERROR_CODE_LENGTH = NAVIGATION_ERROR_CODE_MAX_LENGTH;
export const APP_NAVIGATION_MAX_ERROR_MESSAGE_LENGTH = NAVIGATION_ERROR_MESSAGE_MAX_LENGTH;

export type AppNavigationLaunch = NavigationLaunch;

export type AppNavigationTarget =
  | {
      kind: "app";
      /** Public App URL, app:// ref, or a stable App id. */
      ref: string;
      launch?: AppNavigationLaunch;
    }
  | {
      kind: "file";
      spaceId: string;
      path: string;
      view?: { line?: number; column?: number };
    }
  | {
      kind: "session";
      spaceId: string;
      sessionId: string;
      turnId?: string;
    }
  | {
      kind: "task";
      spaceId: string;
      taskRunId: string;
    }
  | {
      kind: "checkpoint";
      spaceId: string;
      checkpointId: string;
    }
  | {
      kind: "cronjob";
      spaceId: string;
      cronjobId: string;
    };

export type AppNavigationCall = NavigationCall;

export type AppNavigationOpenMessage = {
  protocol: typeof APP_NAVIGATION_PROTOCOL;
  version: typeof APP_NAVIGATION_VERSION;
  type: "open";
  requestId: string;
  target: AppNavigationTarget;
  call?: AppNavigationCall;
};

export type AppNavigationOpenResponse = {
  protocol: typeof APP_NAVIGATION_PROTOCOL;
  version: typeof APP_NAVIGATION_VERSION;
  type: "open.result";
  requestId: string;
  handled: boolean;
  reason?: "unsupported" | "invalid_target" | "inaccessible" | "timeout";
  call?:
    | { ok: true; result?: unknown }
    | { ok: false; code: string; message: string };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() && value.length <= max
    ? value
    : null;

function parseLaunch(value: unknown): AppNavigationLaunch | undefined {
  if (!isRecord(value)) return undefined;
  const search = text(value.search, APP_NAVIGATION_MAX_REF_LENGTH);
  const hash = text(value.hash, APP_NAVIGATION_MAX_REF_LENGTH);
  return {
    ...(search ? { search } : {}),
    ...(hash ? { hash } : {}),
  };
}

export function parseAppNavigationOpenMessage(
  value: unknown,
): AppNavigationOpenMessage | null {
  if (!isRecord(value)) return null;
  if (
    value.protocol !== APP_NAVIGATION_PROTOCOL ||
    value.version !== APP_NAVIGATION_VERSION ||
    value.type !== "open"
  )
    return null;
  const requestId = text(value.requestId, 128);
  if (!requestId || !isRecord(value.target)) return null;

  let target: AppNavigationTarget;
  if (value.target.kind === "app") {
    const ref = text(value.target.ref, APP_NAVIGATION_MAX_REF_LENGTH);
    if (!ref) return null;
    const launch = parseLaunch(value.target.launch);
    target = { kind: "app", ref, ...(launch ? { launch } : {}) };
  } else if (
    value.target.kind === "file" ||
    value.target.kind === "session" ||
    value.target.kind === "task" ||
    value.target.kind === "checkpoint" ||
    value.target.kind === "cronjob"
  ) {
    const spaceId = text(value.target.spaceId, 128);
    if (!spaceId || !isUuid(spaceId)) return null;
    if (value.target.kind === "file") {
      const path = text(value.target.path, 2_048);
      if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "..")) return null;
      let view: { line?: number; column?: number } | undefined;
      if (value.target.view !== undefined) {
        if (!isRecord(value.target.view)) return null;
        const line = value.target.view.line;
        const column = value.target.view.column;
        if (typeof line !== "number" || !Number.isInteger(line) || line <= 0) return null;
        if (column !== undefined && (typeof column !== "number" || !Number.isInteger(column) || column <= 0)) return null;
        view = { line, ...(column === undefined ? {} : { column }) };
      }
      target = { kind: "file", spaceId, path, ...(view ? { view } : {}) };
    } else {
      const keyName = value.target.kind === "session"
        ? "sessionId"
        : value.target.kind === "task"
          ? "taskRunId"
          : value.target.kind === "checkpoint"
            ? "checkpointId"
            : "cronjobId";
      const key = text(value.target[keyName], 128);
      if (!key || !isUuid(key)) return null;
      target = { kind: value.target.kind, spaceId, [keyName]: key } as AppNavigationTarget;
      if (value.target.kind === "session" && value.target.turnId !== undefined) {
        const turnId = text(value.target.turnId, 128);
        if (!turnId || !isUuid(turnId)) return null;
        target = { ...target, turnId } as AppNavigationTarget;
      }
    }
  } else return null;

  let call: AppNavigationCall | undefined;
  if (value.call !== undefined) {
    if (!isRecord(value.call)) return null;
    const method = text(value.call.method, APP_NAVIGATION_MAX_METHOD_LENGTH);
    if (!method) return null;
    call = {
      method,
      ...(value.call.input === undefined ? {} : { input: value.call.input }),
    };
  }
  if (call && target.kind !== "app") return null;
  return {
    protocol: APP_NAVIGATION_PROTOCOL,
    version: APP_NAVIGATION_VERSION,
    type: "open",
    requestId,
    target,
    ...(call ? { call } : {}),
  };
}

export const buildAppNavigationOpenMessage = (
  input: Omit<AppNavigationOpenMessage, "protocol" | "version" | "type">,
): AppNavigationOpenMessage => ({
  protocol: APP_NAVIGATION_PROTOCOL,
  version: APP_NAVIGATION_VERSION,
  type: "open",
  ...input,
});

export const buildAppNavigationOpenResponse = (
  input: Omit<AppNavigationOpenResponse, "protocol" | "version" | "type">,
): AppNavigationOpenResponse => ({
  protocol: APP_NAVIGATION_PROTOCOL,
  version: APP_NAVIGATION_VERSION,
  type: "open.result",
  ...input,
});

const NAVIGATION_REASONS = new Set<AppNavigationOpenResponse["reason"]>([
  "unsupported",
  "invalid_target",
  "inaccessible",
  "timeout",
]);

function parseNavigationCall(value: unknown): AppNavigationOpenResponse["call"] | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.ok !== "boolean") return null;
  if (value.ok) return { ok: true, ...(value.result === undefined ? {} : { result: value.result }) };
  const code = text(value.code, APP_NAVIGATION_MAX_ERROR_CODE_LENGTH);
  const message = text(value.message, APP_NAVIGATION_MAX_ERROR_MESSAGE_LENGTH);
  if (!code || !message) return null;
  return { ok: false, code, message };
}

export const parseAppNavigationOpenResponse = (
  value: unknown,
): AppNavigationOpenResponse | null => {
  if (!isRecord(value)) return null;
  if (
    value.protocol !== APP_NAVIGATION_PROTOCOL ||
    value.version !== APP_NAVIGATION_VERSION ||
    value.type !== "open.result" ||
    !text(value.requestId, 128) ||
    typeof value.handled !== "boolean" ||
    (value.reason !== undefined && !NAVIGATION_REASONS.has(value.reason as AppNavigationOpenResponse["reason"]))
  )
    return null;
  const call = parseNavigationCall(value.call);
  if (call === null) return null;
  return {
    protocol: APP_NAVIGATION_PROTOCOL,
    version: APP_NAVIGATION_VERSION,
    type: "open.result",
    requestId: value.requestId as string,
    handled: value.handled,
    ...(value.reason === undefined ? {} : { reason: value.reason as NonNullable<AppNavigationOpenResponse["reason"]> }),
    ...(call === undefined ? {} : { call }),
  };
};
