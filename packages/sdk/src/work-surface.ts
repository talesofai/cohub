import {
  buildWorkComposerChipClear,
  buildWorkComposerChipSet,
  buildWorkSurfaceReady,
  buildWorkSurfaceResponse,
  parseWorkComposerChipClear,
  parseWorkComposerChipSet,
  parseWorkSurfaceRequest,
  type WorkComposerChip,
} from "@cohub/protocol/work-surface";
export type WorkSurfaceHandlerContext = {
  /** The UI command this handler must complete. */
  commandId: string;
};

export type WorkSurfaceHandler = (
  input: unknown,
  context: WorkSurfaceHandlerContext,
) => unknown | Promise<unknown>;

/**
 * Explicit app origins, not a `*.cohub.run` suffix match: Works themselves are
 * served from Cohub subdomains, so a suffix match would let one Work call into
 * another and turn a subdomain takeover into surface access.
 */
export const COHUB_APP_ORIGINS: readonly string[] = [
  "https://cohub.run",
  "https://www.cohub.run",
  "https://dev.cohub.run",
];

export const isCohubHostOrigin = (origin: string): boolean =>
  COHUB_APP_ORIGINS.includes(origin);

const resolveEmbedderOrigin = (): string | null => {
  if (typeof window === "undefined" || window.parent === window) return null;
  const ancestor = window.location?.ancestorOrigins?.[0];
  if (typeof ancestor === "string" && ancestor) return ancestor;
  try {
    const referrer = typeof document === "undefined" ? "" : document.referrer;
    return referrer ? new URL(referrer).origin : null;
  } catch {
    return null;
  }
};

export class WorkSurfaceApi {
  private readonly handlers = new Map<string, WorkSurfaceHandler>();
  private listening = false;
  private allowedOrigins: string[] | null = null;
  private trustedOrigin: string | null | undefined;

  allowHostOrigins(origins: string[]): void {
    this.allowedOrigins = origins
      .map((origin) => origin.trim())
      .filter(Boolean)
      .map((origin) => {
        try {
          return new URL(origin).origin;
        } catch {
          return "";
        }
      })
      .filter(Boolean);
    this.trustedOrigin = undefined;
    this.announce();
  }

  handle(method: string, handler: WorkSurfaceHandler): () => void {
    const name = method.trim();
    if (!name) throw new Error("Work surface method name is required");
    this.handlers.set(name, handler);
    this.start();
    this.announce();
    return () => {
      if (this.handlers.get(name) === handler) {
        this.handlers.delete(name);
        this.announce();
      }
    };
  }

  get methods(): string[] {
    return [...this.handlers.keys()];
  }

  setComposerChip(chip: WorkComposerChip): void {
    const message = parseWorkComposerChipSet(buildWorkComposerChipSet(chip));
    if (!message) throw new Error("Invalid Work composer chip");
    this.post(message);
  }

  clearComposerChip(key: string): void {
    const message = parseWorkComposerChipClear(buildWorkComposerChipClear(key));
    if (!message) throw new Error("Invalid Work composer chip key");
    this.post(message);
  }

  announce(): void {
    this.post(buildWorkSurfaceReady(this.methods));
  }

  private isTrusted(origin: string): boolean {
    if (!origin || origin === "null") return false;
    // Same-origin grants nothing new: such a parent can already script us.
    if (typeof window !== "undefined" && origin === window.location?.origin) return true;
    return this.allowedOrigins
      ? this.allowedOrigins.includes(origin)
      : isCohubHostOrigin(origin);
  }

  private resolveTrustedOrigin(): string | null {
    if (this.trustedOrigin !== undefined) return this.trustedOrigin;
    const embedder = resolveEmbedderOrigin();
    this.trustedOrigin = embedder && this.isTrusted(embedder) ? embedder : null;
    return this.trustedOrigin;
  }

  private start(): void {
    if (this.listening || typeof window === "undefined") return;
    this.listening = true;
    window.addEventListener("message", this.onMessage);
  }

  private readonly onMessage = (event: MessageEvent) => {
    if (typeof window === "undefined" || event.source !== window.parent) return;
    if (!this.isTrusted(event.origin)) return;
    const request = parseWorkSurfaceRequest(event.data);
    if (!request) return;
    const commandId = request.commandId;
    if (!commandId) return;
    this.trustedOrigin = event.origin;
    void this.dispatch(
      request.requestId,
      request.method,
      request.input,
      commandId,
    );
  };

  private async dispatch(
    requestId: string,
    method: string,
    input: unknown,
    commandId: string,
  ): Promise<void> {
    const handler = this.handlers.get(method);
    if (!handler) {
      this.post(
        buildWorkSurfaceResponse({
          requestId,
          ok: false,
          error: {
            code: "method_not_found",
            message: `This Work does not expose "${method}".`,
          },
        }),
      );
      return;
    }
    try {
      await handler(input, { commandId });
      this.post(buildWorkSurfaceResponse({ requestId, ok: true }));
    } catch (error) {
      this.post(
        buildWorkSurfaceResponse({
          requestId,
          ok: false,
          error: {
            code: "handler_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    }
  }

  private post(message: Record<string, unknown>): void {
    if (typeof window === "undefined" || window.parent === window) return;
    // Never `*`: the method list and results go to the trusted host only.
    const origin = this.resolveTrustedOrigin();
    if (!origin) return;
    try {
      window.parent.postMessage(message, origin);
    } catch {
    }
  }
}
