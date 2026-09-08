import {
  type AppEmbedShell,
  buildAppEmbedAttach,
  buildAppEmbedShellChanged,
  parseAppEmbedAttachRequest,
  parseAppEmbedCloseRequest,
} from "@cohub/protocol/app-embed";

export type { AppEmbedShell } from "@cohub/protocol/app-embed";

export type AppEmbedAttachOptions = {
  /** The embedding App's id, shown to the embedded App as `invocation.embedder` (display only). */
  appId: string;
  /** Shell location to forward; usually the embedder's own `context.shell`. */
  shell?: AppEmbedShell | null;
  /** The embedded App asked to be closed. */
  onCloseRequest?: () => void;
};

export type AppEmbedHandle = {
  readonly embedId: string;
  /** Forwards a new shell location to the embedded App. */
  setShell: (shell: AppEmbedShell | null) => void;
  dispose: () => void;
};

const generateEmbedId = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const frameOrigin = (frame: HTMLIFrameElement) => {
  try {
    return new URL(frame.src, window.location.href).origin;
  } catch {
    return null;
  }
};

/**
 * Attaches to an iframe that renders a Cohub public App page. The page keeps
 * owning the embedded App's runtime; this only forwards navigation hints and
 * relays the App's close intent back to the embedder.
 */
export function attachAppEmbed(frame: HTMLIFrameElement, options: AppEmbedAttachOptions): AppEmbedHandle {
  const embedId = generateEmbedId();
  let shell = options.shell ?? null;

  const post = (message: Record<string, unknown>) => {
    const origin = frameOrigin(frame);
    if (!origin) return;
    try {
      frame.contentWindow?.postMessage(message, origin);
    } catch {
      // The frame may be navigating.
    }
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== frameOrigin(frame)) return;
    if (parseAppEmbedAttachRequest(event.data)) {
      post(buildAppEmbedAttach({ embedId, embedder: { appId: options.appId }, shell }));
      return;
    }
    const close = parseAppEmbedCloseRequest(event.data);
    if (close?.embedId === embedId) options.onCloseRequest?.();
  };
  window.addEventListener("message", onMessage);

  return {
    embedId,
    setShell(next) {
      shell = next;
      post(buildAppEmbedShellChanged({ embedId, shell }));
    },
    dispose() {
      window.removeEventListener("message", onMessage);
    },
  };
}
