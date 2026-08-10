import { parseUiCommandId } from "./ui-command.js";

export const WORK_SURFACE_PROTOCOL = "cohub.surface";
export const WORK_SURFACE_VERSION = 1;

export const WORK_SURFACE_READY_TIMEOUT_MS = 10_000;
export const WORK_SURFACE_REQUEST_TIMEOUT_MS = 15_000;
export const WORK_COMPOSER_CHIP_KEY_MAX_LENGTH = 80;
export const WORK_COMPOSER_CHIP_LABEL_MAX_LENGTH = 120;
export const WORK_COMPOSER_CHIP_CONTENT_MAX_BYTES = 32 * 1024;

type SurfaceEnvelope = {
  protocol: typeof WORK_SURFACE_PROTOCOL;
  version: typeof WORK_SURFACE_VERSION;
};

export type WorkSurfaceReadyMessage = SurfaceEnvelope & {
  type: "ready";
  methods: string[];
};

export type WorkSurfaceRequestMessage = SurfaceEnvelope & {
  type: "request";
  requestId: string;
  method: string;
  input?: unknown;
  /** The originating UI command that the Work will complete. */
  commandId: string;
};

export type WorkSurfaceResponseMessage = SurfaceEnvelope & {
  type: "response";
  requestId: string;
  ok: boolean;
  error?: { code: string; message: string };
};

export type WorkComposerChip = {
  key: string;
  label: string;
  content: string;
};

export type WorkComposerChipSetMessage = SurfaceEnvelope & {
  type: "composer.chip.set";
  chip: WorkComposerChip;
};

export type WorkComposerChipClearMessage = SurfaceEnvelope & {
  type: "composer.chip.clear";
  key: string;
};

export type WorkSurfaceHostMessage = WorkSurfaceRequestMessage;
export type WorkSurfaceClientMessage =
  | WorkSurfaceReadyMessage
  | WorkSurfaceResponseMessage
  | WorkComposerChipSetMessage
  | WorkComposerChipClearMessage;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const isSurfaceEnvelope = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) &&
  value.protocol === WORK_SURFACE_PROTOCOL &&
  value.version === WORK_SURFACE_VERSION;

export const parseWorkSurfaceReady = (value: unknown): WorkSurfaceReadyMessage | null => {
  if (!isSurfaceEnvelope(value) || value.type !== "ready") return null;
  const methods = Array.isArray(value.methods)
    ? value.methods.filter((method): method is string => typeof method === "string" && Boolean(method))
    : [];
  return {
    protocol: WORK_SURFACE_PROTOCOL,
    version: WORK_SURFACE_VERSION,
    type: "ready",
    methods,
  };
};

export const parseWorkSurfaceResponse = (value: unknown): WorkSurfaceResponseMessage | null => {
  if (!isSurfaceEnvelope(value) || value.type !== "response") return null;
  if (typeof value.requestId !== "string" || !value.requestId) return null;
  const error = isRecord(value.error)
    ? {
        code: typeof value.error.code === "string" && value.error.code ? value.error.code : "surface_error",
        message: typeof value.error.message === "string" ? value.error.message : "Work surface call failed",
      }
    : undefined;
  return {
    protocol: WORK_SURFACE_PROTOCOL,
    version: WORK_SURFACE_VERSION,
    type: "response",
    requestId: value.requestId,
    ok: value.ok === true,
    ...(error ? { error } : {}),
  };
};

const parseComposerChipKey = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!key || key.length > WORK_COMPOSER_CHIP_KEY_MAX_LENGTH) return null;
  return key;
};

export const parseWorkComposerChipSet = (value: unknown): WorkComposerChipSetMessage | null => {
  if (!isSurfaceEnvelope(value) || value.type !== "composer.chip.set" || !isRecord(value.chip)) {
    return null;
  }
  const key = parseComposerChipKey(value.chip.key);
  if (!key || typeof value.chip.label !== "string" || typeof value.chip.content !== "string") {
    return null;
  }
  const label = value.chip.label.trim();
  if (!label || label.length > WORK_COMPOSER_CHIP_LABEL_MAX_LENGTH) return null;
  if (!value.chip.content.trim()) return null;
  if (new TextEncoder().encode(value.chip.content).length > WORK_COMPOSER_CHIP_CONTENT_MAX_BYTES) {
    return null;
  }
  return {
    protocol: WORK_SURFACE_PROTOCOL,
    version: WORK_SURFACE_VERSION,
    type: "composer.chip.set",
    chip: { key, label, content: value.chip.content },
  };
};

export const parseWorkComposerChipClear = (value: unknown): WorkComposerChipClearMessage | null => {
  if (!isSurfaceEnvelope(value) || value.type !== "composer.chip.clear") return null;
  const key = parseComposerChipKey(value.key);
  return key
    ? {
        protocol: WORK_SURFACE_PROTOCOL,
        version: WORK_SURFACE_VERSION,
        type: "composer.chip.clear",
        key,
      }
    : null;
};

export const parseWorkSurfaceRequest = (value: unknown): WorkSurfaceRequestMessage | null => {
  if (!isSurfaceEnvelope(value) || value.type !== "request") return null;
  if (typeof value.requestId !== "string" || !value.requestId) return null;
  if (typeof value.method !== "string" || !value.method) return null;
  const commandId = parseUiCommandId(value.commandId);
  if (!commandId) return null;
  return {
    protocol: WORK_SURFACE_PROTOCOL,
    version: WORK_SURFACE_VERSION,
    type: "request",
    requestId: value.requestId,
    method: value.method,
    ...(value.input === undefined ? {} : { input: value.input }),
    commandId,
  };
};

export const buildWorkSurfaceReady = (methods: string[]): WorkSurfaceReadyMessage => ({
  protocol: WORK_SURFACE_PROTOCOL,
  version: WORK_SURFACE_VERSION,
  type: "ready",
  methods: [...methods],
});

export const buildWorkSurfaceRequest = (
  input: Omit<WorkSurfaceRequestMessage, keyof SurfaceEnvelope | "type">,
): WorkSurfaceRequestMessage => ({
  protocol: WORK_SURFACE_PROTOCOL,
  version: WORK_SURFACE_VERSION,
  type: "request",
  ...input,
});

export const buildWorkSurfaceResponse = (
  input: Omit<WorkSurfaceResponseMessage, keyof SurfaceEnvelope | "type">,
): WorkSurfaceResponseMessage => ({
  protocol: WORK_SURFACE_PROTOCOL,
  version: WORK_SURFACE_VERSION,
  type: "response",
  ...input,
});

export const buildWorkComposerChipSet = (chip: WorkComposerChip): WorkComposerChipSetMessage => ({
  protocol: WORK_SURFACE_PROTOCOL,
  version: WORK_SURFACE_VERSION,
  type: "composer.chip.set",
  chip,
});

export const buildWorkComposerChipClear = (key: string): WorkComposerChipClearMessage => ({
  protocol: WORK_SURFACE_PROTOCOL,
  version: WORK_SURFACE_VERSION,
  type: "composer.chip.clear",
  key,
});
