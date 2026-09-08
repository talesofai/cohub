import { isUuid } from "./identifiers.js";

/**
 * Embed protocol between an embedder App and the public App page it renders in
 * an iframe. The public page keeps owning the embedded App's runtime bridge;
 * this channel only carries navigation hints and window intents.
 */
export const APP_EMBED_PROTOCOL = "cohub.app.embed";
export const APP_EMBED_VERSION = 1;
export const APP_EMBED_ID_MAX_LENGTH = 128;
export const APP_EMBED_SPACE_NAME_MAX_LENGTH = 256;

type EmbedEnvelope = {
  protocol: typeof APP_EMBED_PROTOCOL;
  version: typeof APP_EMBED_VERSION;
};

/** Shell location the embedder forwards to the embedded App. */
export type AppEmbedShell = {
  space: { id: string; name?: string | null } | null;
  session: { id: string } | null;
  turn: { id: string } | null;
};

/** Public page → embedder: the page is ready to be attached. */
export type AppEmbedAttachRequestMessage = EmbedEnvelope & {
  type: "attach.request";
};

/** Embedder → public page: identifies the embedder and the current shell. */
export type AppEmbedAttachMessage = EmbedEnvelope & {
  type: "attach";
  embedId: string;
  embedder: { appId: string };
  shell: AppEmbedShell | null;
};

/** Embedder → public page: the shell location changed. */
export type AppEmbedShellChangedMessage = EmbedEnvelope & {
  type: "shell.changed";
  embedId: string;
  shell: AppEmbedShell | null;
};

/** Public page → embedder: the embedded App asked to be closed. */
export type AppEmbedCloseRequestMessage = EmbedEnvelope & {
  type: "close.request";
  embedId: string;
};

export type AppEmbedEmbedderMessage = AppEmbedAttachMessage | AppEmbedShellChangedMessage;
export type AppEmbedPageMessage = AppEmbedAttachRequestMessage | AppEmbedCloseRequestMessage;

const envelope: EmbedEnvelope = { protocol: APP_EMBED_PROTOCOL, version: APP_EMBED_VERSION };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const isEnvelope = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) &&
  value.protocol === APP_EMBED_PROTOCOL &&
  value.version === APP_EMBED_VERSION;

const parseEmbedId = (value: unknown) =>
  typeof value === "string" && value.trim() && value.length <= APP_EMBED_ID_MAX_LENGTH
    ? value
    : null;

const parseRef = (value: unknown): { id: string } | null | undefined => {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.id !== "string" || !isUuid(value.id)) return undefined;
  return { id: value.id };
};

/** Structural check only: hints are never used for authorization. */
export function parseAppEmbedShell(value: unknown): AppEmbedShell | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const space = parseRef(value.space);
  const session = parseRef(value.session);
  const turn = parseRef(value.turn);
  if (space === undefined || session === undefined || turn === undefined) return undefined;
  // Same hierarchy as the workspace: a Turn needs a Session, a Session needs a Space.
  if ((!space && session) || (!session && turn)) return undefined;
  if (!space) return { space: null, session: null, turn: null };
  const rawName = isRecord(value.space) ? value.space.name : undefined;
  const name =
    typeof rawName === "string" && rawName.length <= APP_EMBED_SPACE_NAME_MAX_LENGTH
      ? rawName
      : null;
  return { space: { ...space, name }, session, turn };
}

export function parseAppEmbedAttachRequest(value: unknown): AppEmbedAttachRequestMessage | null {
  if (!isEnvelope(value) || value.type !== "attach.request") return null;
  return { ...envelope, type: "attach.request" };
}

export function parseAppEmbedAttach(value: unknown): AppEmbedAttachMessage | null {
  if (!isEnvelope(value) || value.type !== "attach") return null;
  const embedId = parseEmbedId(value.embedId);
  const appId = isRecord(value.embedder) ? value.embedder.appId : null;
  const shell = parseAppEmbedShell(value.shell);
  if (!embedId || typeof appId !== "string" || !isUuid(appId) || shell === undefined) return null;
  return { ...envelope, type: "attach", embedId, embedder: { appId }, shell };
}

export function parseAppEmbedShellChanged(value: unknown): AppEmbedShellChangedMessage | null {
  if (!isEnvelope(value) || value.type !== "shell.changed") return null;
  const embedId = parseEmbedId(value.embedId);
  const shell = parseAppEmbedShell(value.shell);
  if (!embedId || shell === undefined) return null;
  return { ...envelope, type: "shell.changed", embedId, shell };
}

export function parseAppEmbedCloseRequest(value: unknown): AppEmbedCloseRequestMessage | null {
  if (!isEnvelope(value) || value.type !== "close.request") return null;
  const embedId = parseEmbedId(value.embedId);
  return embedId ? { ...envelope, type: "close.request", embedId } : null;
}

export const buildAppEmbedAttachRequest = (): AppEmbedAttachRequestMessage => ({
  ...envelope,
  type: "attach.request",
});

export const buildAppEmbedAttach = (
  input: Omit<AppEmbedAttachMessage, keyof EmbedEnvelope | "type">,
): AppEmbedAttachMessage => ({ ...envelope, type: "attach", ...input });

export const buildAppEmbedShellChanged = (
  input: Omit<AppEmbedShellChangedMessage, keyof EmbedEnvelope | "type">,
): AppEmbedShellChangedMessage => ({ ...envelope, type: "shell.changed", ...input });

export const buildAppEmbedCloseRequest = (embedId: string): AppEmbedCloseRequestMessage => ({
  ...envelope,
  type: "close.request",
  embedId,
});
