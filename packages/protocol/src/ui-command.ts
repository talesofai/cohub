/**
 * Lets an agent drive the Cohub frontend that originated the work. Routing comes
 * from request provenance, never a caller-supplied target, so a command only
 * reaches the actor's own instances.
 */

import type { RequestSource } from "./provenance.js";

export const UI_COMMAND_VERSION = 1;

/** Persisted and broadcast, so every field is capped; MAX_BYTES bounds the whole. */
export const UI_COMMAND_PAYLOAD_MAX_BYTES = 32 * 1024;
export const UI_COMMAND_MAX_BYTES = 40 * 1024;
export const UI_COMMAND_LABEL_MAX_LENGTH = 200;
export const UI_COMMAND_LAUNCH_MAX_LENGTH = 2_048;
/** Becomes part of a Redis key. */
export const UI_COMMAND_ID_MAX_LENGTH = 64;
export const UI_COMMAND_ERROR_CODE_MAX_LENGTH = 64;
export const UI_COMMAND_ERROR_MESSAGE_MAX_LENGTH = 2_000;

export const UI_COMMAND_DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
export const UI_COMMAND_MAX_TIMEOUT_MS = 12 * 60 * 60 * 1_000;
export const UI_COMMAND_SETTLEMENT_GRACE_SECONDS = 10 * 60;
/** Keeps pending commands reportable for the full wait window plus settlement grace. */
export const UI_COMMAND_PENDING_TTL_SECONDS =
  UI_COMMAND_MAX_TIMEOUT_MS / 1_000 + UI_COMMAND_SETTLEMENT_GRACE_SECONDS;
export const UI_COMMAND_TERMINAL_TTL_SECONDS = 30 * 60;

export type UiCommandStatus =
  | "pending"
  | "applied"
  | "no_active_client"
  | "ui_host_unavailable"
  | "rejected"
  | "unsupported"
  | "timeout";

export const UI_COMMAND_TERMINAL_STATUSES: readonly UiCommandStatus[] = [
  "applied",
  "no_active_client",
  "ui_host_unavailable",
  "rejected",
  "unsupported",
  "timeout",
];

export const isTerminalUiCommandStatus = (status: UiCommandStatus): boolean =>
  UI_COMMAND_TERMINAL_STATUSES.includes(status);

export type UiWorkPreviewTarget = {
  kind: "work";
  workId: string;
  label?: string;
  launch?: { search?: string; hash?: string };
};

export type UiPreviewTarget = UiWorkPreviewTarget;

export type UiSurfaceRequest = {
  method: string;
  input?: unknown;
};

export type UiPreviewShowCommand = {
  type: "preview.show";
  preview: UiPreviewTarget;
  request?: UiSurfaceRequest;
};

export type UiCommand = UiPreviewShowCommand;

export type UiCommandError = {
  code: string;
  message: string;
};

export type UiCommandRecord = {
  version: typeof UI_COMMAND_VERSION;
  commandId: string;
  status: UiCommandStatus;
  command: UiCommand;
  actorUserId: string;
  targetClientId: string;
  source: RequestSource | null;
  result?: unknown;
  error?: UiCommandError | null;
  createdAt: string;
  settledAt?: string | null;
};

export type UiCommandDispatchedPayload = {
  commandId: string;
  targetClientId: string;
  command: UiCommand;
  source: RequestSource | null;
};

const METHOD_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

export const isUiSurfaceMethod = (value: unknown): value is string =>
  typeof value === "string" && METHOD_RE.test(value);

const WORK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const UI_COMMAND_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const parseUiCommandId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return UI_COMMAND_ID_RE.test(trimmed) ? trimmed : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const asTrimmed = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const parseLaunch = (value: unknown): UiWorkPreviewTarget["launch"] | undefined => {
  if (!isRecord(value)) return undefined;
  const search = asTrimmed(value.search);
  const hash = asTrimmed(value.hash);
  if (!search && !hash) return undefined;
  return {
    ...(search ? { search: search.startsWith("?") ? search : `?${search}` } : {}),
    ...(hash ? { hash: hash.startsWith("#") ? hash : `#${hash}` } : {}),
  };
};

export const measureUiCommandPayload = (value: unknown): number | null => {
  if (value === undefined) return 0;
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
  } catch {
    return null;
  }
};

export const parseUiCommandError = (
  value: unknown,
  fallbackCode: string,
): UiCommandError | null => {
  if (!isRecord(value)) return null;
  const code = asTrimmed(value.code) ?? fallbackCode;
  const message = asTrimmed(value.message) ?? "UI command failed";
  return {
    code: code.slice(0, UI_COMMAND_ERROR_CODE_MAX_LENGTH),
    message: message.slice(0, UI_COMMAND_ERROR_MESSAGE_MAX_LENGTH),
  };
};

export type ParsedUiCommand =
  | { command: UiCommand; error: null }
  | { command: null; error: string };

export const parseUiCommand = (input: unknown): ParsedUiCommand => {
  if (!isRecord(input)) return { command: null, error: "command must be an object" };
  if (input.type !== "preview.show") {
    return { command: null, error: "command.type must be one of: preview.show" };
  }

  const preview = input.preview;
  if (!isRecord(preview)) return { command: null, error: "command.preview is required" };
  if (preview.kind !== "work") {
    return { command: null, error: "command.preview.kind must be one of: work" };
  }
  const workId = asTrimmed(preview.workId);
  if (!workId) return { command: null, error: "command.preview.workId is required" };
  if (!WORK_ID_RE.test(workId)) {
    return { command: null, error: "command.preview.workId must be a Work id" };
  }
  const label = asTrimmed(preview.label);
  if (label && label.length > UI_COMMAND_LABEL_MAX_LENGTH) {
    return {
      command: null,
      error: `command.preview.label exceeds ${UI_COMMAND_LABEL_MAX_LENGTH} characters`,
    };
  }
  const launch = parseLaunch(preview.launch);
  if (launch) {
    for (const [field, value] of [
      ["search", launch.search],
      ["hash", launch.hash],
    ] as const) {
      if (value && value.length > UI_COMMAND_LAUNCH_MAX_LENGTH) {
        return {
          command: null,
          error: `command.preview.launch.${field} exceeds ${UI_COMMAND_LAUNCH_MAX_LENGTH} characters`,
        };
      }
    }
  }

  let request: UiSurfaceRequest | undefined;
  if (input.request !== undefined && input.request !== null) {
    if (!isRecord(input.request)) {
      return { command: null, error: "command.request must be an object" };
    }
    const method = asTrimmed(input.request.method);
    if (!method) return { command: null, error: "command.request.method is required" };
    if (!isUiSurfaceMethod(method)) {
      return { command: null, error: "command.request.method has an unsupported format" };
    }
    const size = measureUiCommandPayload(input.request.input);
    if (size === null) {
      return { command: null, error: "command.request.input must be JSON-serializable" };
    }
    if (size > UI_COMMAND_PAYLOAD_MAX_BYTES) {
      return {
        command: null,
        error: `command.request.input exceeds ${UI_COMMAND_PAYLOAD_MAX_BYTES} bytes`,
      };
    }
    request = {
      method,
      ...(input.request.input === undefined ? {} : { input: input.request.input }),
    };
  }

  const command: UiCommand = {
    type: "preview.show",
    preview: {
      kind: "work",
      workId,
      ...(label ? { label } : {}),
      ...(launch ? { launch } : {}),
    },
    ...(request ? { request } : {}),
  };

  const totalSize = measureUiCommandPayload(command);
  if (totalSize === null) return { command: null, error: "command must be JSON-serializable" };
  if (totalSize > UI_COMMAND_MAX_BYTES) {
    return { command: null, error: `command exceeds ${UI_COMMAND_MAX_BYTES} bytes` };
  }

  return { command, error: null };
};
