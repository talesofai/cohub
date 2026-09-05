import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizePermissionScopes, type Permission } from "../permissions/index.js";

const EXECUTION_GRANT_TTL_SECONDS = 24 * 60 * 60;
const EXECUTION_GRANT_HEADER = { alg: "HS256", typ: "JWT" } as const;

export type ExecutionGrantPayload = {
  actorUserId: string | null;
  /** The end user on whose behalf an App Action is running. */
  viewerUserId?: string | null;
  appId?: string | null;
  appVersionId?: string | null;
  action?: string | null;
  taskRunId?: string | null;
  spaceId: string;
  sessionId: string | null;
  turnId: string | null;
  source: string;
  scopes?: Permission[];
  exp: number;
  iat: number;
};

export type SessionExecutionGrant = {
  token: string;
  expiresAt: number;
};

export type ExecutionGrantService = {
  createExecutionGrant(input: {
    actorUserId: string | null;
    viewerUserId?: string | null;
    appId?: string | null;
    appVersionId?: string | null;
    action?: string | null;
    taskRunId?: string | null;
    spaceId: string;
    sessionId: string | null;
    turnId: string | null;
    source: string;
    scopes?: string[];
  }): Promise<SessionExecutionGrant>;
  verifyExecutionGrant(token: string): Promise<ExecutionGrantPayload | null>;
};

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

export function createExecutionGrantService(input: {
  signingKey: string;
  now?: () => Date;
}): ExecutionGrantService {
  const signingKey = input.signingKey?.trim();
  if (!signingKey) throw new Error("execution grant signing key is required");
  const now = input.now ?? (() => new Date());
  const sign = (value: string) => createHmac("sha256", signingKey).update(value).digest("base64url");

  return {
    async createExecutionGrant(grantInput) {
      const spaceId = grantInput.spaceId?.trim();
      if (!spaceId) throw new Error("Execution grant requires a non-empty spaceId");
      const nowSeconds = Math.floor(now().getTime() / 1000);
      const payload: ExecutionGrantPayload = {
        actorUserId: grantInput.actorUserId?.trim() || null,
        ...(grantInput.viewerUserId?.trim() ? { viewerUserId: grantInput.viewerUserId.trim() } : {}),
        ...(grantInput.appId?.trim() ? { appId: grantInput.appId.trim() } : {}),
        ...(grantInput.appVersionId?.trim() ? { appVersionId: grantInput.appVersionId.trim() } : {}),
        ...(grantInput.action?.trim() ? { action: grantInput.action.trim() } : {}),
        ...(grantInput.taskRunId?.trim() ? { taskRunId: grantInput.taskRunId.trim() } : {}),
        spaceId,
        sessionId: grantInput.sessionId?.trim() || null,
        turnId: grantInput.turnId?.trim() || null,
        source: grantInput.source?.trim() || "prompt",
        scopes: normalizePermissionScopes(grantInput.scopes ?? []),
        iat: nowSeconds,
        exp: nowSeconds + EXECUTION_GRANT_TTL_SECONDS,
      };

      const encodedHeader = base64UrlEncode(JSON.stringify(EXECUTION_GRANT_HEADER));
      const encodedPayload = base64UrlEncode(JSON.stringify(payload));
      const signingInput = `${encodedHeader}.${encodedPayload}`;
      const signature = sign(signingInput);
      return { token: `${signingInput}.${signature}`, expiresAt: payload.exp * 1000 };
    },

    async verifyExecutionGrant(token) {
      const parts = token.split(".");
      if (parts.length !== 3) return null;

      const [encodedHeader, encodedPayload, providedSignature] = parts;
      if (!encodedHeader || !encodedPayload || !providedSignature) return null;

      const expectedSignature = sign(`${encodedHeader}.${encodedPayload}`);
      const provided = Buffer.from(providedSignature);
      const expected = Buffer.from(expectedSignature);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

      let parsedHeader: { alg?: string; typ?: string } | null = null;
      let parsedPayload: ExecutionGrantPayload | null = null;
      try {
        parsedHeader = JSON.parse(base64UrlDecode(encodedHeader)) as { alg?: string; typ?: string };
        parsedPayload = JSON.parse(base64UrlDecode(encodedPayload)) as ExecutionGrantPayload;
      } catch {
        return null;
      }

      if (parsedHeader?.alg !== "HS256" || parsedHeader?.typ !== "JWT") return null;
      if (!parsedPayload || typeof parsedPayload !== "object") return null;
      if (typeof parsedPayload.spaceId !== "string" || !parsedPayload.spaceId.trim()) return null;
      if (typeof parsedPayload.source !== "string" || !parsedPayload.source.trim()) return null;
      if (typeof parsedPayload.exp !== "number" || !Number.isFinite(parsedPayload.exp)) return null;
      if (typeof parsedPayload.iat !== "number" || !Number.isFinite(parsedPayload.iat)) return null;
      if (parsedPayload.exp <= Math.floor(now().getTime() / 1000)) return null;

      return {
        actorUserId: typeof parsedPayload.actorUserId === "string" && parsedPayload.actorUserId.trim() ? parsedPayload.actorUserId.trim() : null,
        ...(typeof parsedPayload.viewerUserId === "string" && parsedPayload.viewerUserId.trim() ? { viewerUserId: parsedPayload.viewerUserId.trim() } : {}),
        ...(typeof parsedPayload.appId === "string" && parsedPayload.appId.trim() ? { appId: parsedPayload.appId.trim() } : {}),
        ...(typeof parsedPayload.appVersionId === "string" && parsedPayload.appVersionId.trim() ? { appVersionId: parsedPayload.appVersionId.trim() } : {}),
        ...(typeof parsedPayload.action === "string" && parsedPayload.action.trim() ? { action: parsedPayload.action.trim() } : {}),
        ...(typeof parsedPayload.taskRunId === "string" && parsedPayload.taskRunId.trim() ? { taskRunId: parsedPayload.taskRunId.trim() } : {}),
        spaceId: parsedPayload.spaceId.trim(),
        sessionId: typeof parsedPayload.sessionId === "string" && parsedPayload.sessionId.trim() ? parsedPayload.sessionId.trim() : null,
        turnId: typeof parsedPayload.turnId === "string" && parsedPayload.turnId.trim() ? parsedPayload.turnId.trim() : null,
        source: parsedPayload.source.trim(),
        scopes: normalizePermissionScopes(Array.isArray(parsedPayload.scopes) ? parsedPayload.scopes : []),
        exp: parsedPayload.exp,
        iat: parsedPayload.iat,
      };
    },
  };
}
