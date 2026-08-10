import "dotenv/config";
import "./tracing.js";
import { configureBillingRuntime } from "@cohub/billing";
import { createLogger } from "@cohub/infra/logging";
import { COHUB_SOURCE_HEADER_NAMES } from "@cohub/protocol/provenance";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { trace } from "@opentelemetry/api";
import { cors } from "hono/cors";
import { getCookie } from "hono/cookie";
import { httpInstrumentationMiddleware } from "@hono/otel";

import { applyTraceResponseHeaders, getActiveTraceIdentifiers, getOrCreateRequestId, runWithRequestTraceContext, setRequestContextAttributes } from "@cohub/infra/tracing";
import { verifyUserAccessToken } from "@cohub/identity";

import { getTokenFromRequest, type AuthUserProfile, consumeExecutionAuthFromToken, type ExecutionAuthPrincipal } from "./auth.js";
import { describeUserAccessTokenFailure } from "./auth-failure.js";
import { recordAuthTrace } from "./auth-observability.js";
import { verifyPreviewSessionToken, type PreviewSessionPrincipal } from "./preview-sessions.js";
import { verifyWorkSessionToken, type WorkSessionPrincipal } from "./work-sessions.js";
import { assertRequiredConfig, config } from "./config.js";

import router from "./routes/index.js";

const logger = createLogger({ serviceName: "cohub-api" });
// ── Hono app ─────────────────────────────────────────────────────────────────

const app = new Hono<{
  Variables: {
    token: string | null;
    authUser: AuthUserProfile | null;
    executionAuth: ExecutionAuthPrincipal | null;
    previewSession: PreviewSessionPrincipal | null;
    workSession: WorkSessionPrincipal | null;
    principal: { type: "user"; user: AuthUserProfile } | { type: "execution"; execution: ExecutionAuthPrincipal } | { type: "preview_session"; previewSession: PreviewSessionPrincipal } | { type: "work_session"; workSession: WorkSessionPrincipal } | null;
    requestId: string;
    traceId: string | null;
  };
}>();

app.use(
  "*",
  httpInstrumentationMiddleware({
    serviceName: "cohub-api",
    serviceVersion: process.env.IMAGE_TAG ?? "latest",
  }),
);

app.use(async (c, next) => {
  const requestId = getOrCreateRequestId(c.req.header("x-request-id"));
  c.set("requestId", requestId);
  await runWithRequestTraceContext({ requestId }, next);
  const ids = getActiveTraceIdentifiers(requestId);
  c.set("traceId", ids.traceId);
  setRequestContextAttributes(trace.getActiveSpan(), ids);
  applyTraceResponseHeaders(c.res.headers, ids);
});

app.use(
  cors({
    origin: (origin) => origin || "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Git-Token",
      "X-Request-Id",
      // Derived, so a new provenance header cannot be added without being allowed
      // here — a missing one fails every cross-origin browser request.
      ...COHUB_SOURCE_HEADER_NAMES,
      "Traceparent",
      "Tracestate",
      "Baggage",
      "Sentry-Trace",
    ],
    exposeHeaders: ["X-Request-Id", "X-Trace-Id", "X-Span-Id", "Traceparent", "Tracestate", "Baggage", "Sentry-Trace"],
    credentials: true,
  }),
);

const PREVIEW_SESSION_COOKIE = "__preview_session";

const isPreviewHost = (host: string | undefined) => {
  const normalized = host?.split(":")[0]?.toLowerCase();
  const configured = process.env.PREVIEW_HOSTNAME?.trim().toLowerCase();
  return Boolean(normalized && configured && normalized === configured);
};

app.use(async (c, next) => {
  const onPreviewHost = isPreviewHost(c.req.header("host"));
  const previewQueryToken =
    onPreviewHost && c.req.path.startsWith("/s/")
      ? c.req.query("token")?.trim() || null
      : null;
  const token =
    getTokenFromRequest(c) ??
    previewQueryToken ??
    (onPreviewHost ? getCookie(c, PREVIEW_SESSION_COOKIE) ?? null : null);
  c.set("token", token);
  c.set("authUser", null);
  c.set("executionAuth", null);
  c.set("previewSession", null);
  c.set("workSession", null);
  c.set("principal", null);

  if (token) {
    const executionAuth = await consumeExecutionAuthFromToken(token).catch((error) => {
      logger.warn("[API] Failed to verify execution token:", error);
      return null;
    });
    if (executionAuth) {
      c.set("executionAuth", executionAuth);
      c.set("principal", { type: "execution", execution: executionAuth });
      recordAuthTrace(trace.getActiveSpan(), {
        credentialPresent: true,
        principalType: "execution",
        outcome: "authenticated",
      });
      await next();
      return;
    }

    if (onPreviewHost) {
      const previewSession = verifyPreviewSessionToken(token);
      if (previewSession) {
        c.set("previewSession", previewSession);
        c.set("principal", { type: "preview_session", previewSession });
        recordAuthTrace(trace.getActiveSpan(), {
          credentialPresent: true,
          principalType: "preview_session",
          outcome: "authenticated",
        });
        await next();
        return;
      }
    }

    const workSession = verifyWorkSessionToken(token);
    if (workSession) {
      c.set("workSession", workSession);
      c.set("principal", { type: "work_session", workSession });
      recordAuthTrace(trace.getActiveSpan(), {
        credentialPresent: true,
        principalType: "work_session",
        outcome: "authenticated",
      });
      await next();
      return;
    }

    try {
      const authUser = await verifyUserAccessToken({ token, logtoEndpoint: config.logtoEndpoint });
      c.set("authUser", authUser);
      c.set("principal", { type: "user", user: authUser });
    } catch (error) {
      const failure = describeUserAccessTokenFailure(error);
      logger.warn("User access token verification failed", {
        auth_failure_reason: failure.reason,
        ...(failure.claim ? { auth_failure_claim: failure.claim } : {}),
        http_method: c.req.method,
      });
      recordAuthTrace(trace.getActiveSpan(), {
        credentialPresent: true,
        principalType: "anonymous",
        outcome: "rejected",
        failureCategory: "invalid_user_token",
      });
      return c.json({ message: "unauthorized" }, 401);
    }

    recordAuthTrace(trace.getActiveSpan(), {
      credentialPresent: true,
      principalType: "user",
      outcome: "authenticated",
    });
  } else {
    recordAuthTrace(trace.getActiveSpan(), {
      credentialPresent: false,
      principalType: "anonymous",
      outcome: "anonymous",
    });
  }

  await next();
});

app.route("/", router);

const ERROR_LOG_FIELDS = ["code", "detail", "hint", "position", "constraint", "table", "column", "schema"] as const;

const serializeErrorForLog = (error: unknown): unknown => {
  if (error instanceof Error) {
    const record = error as Error & Record<string, unknown>;
    const fields = Object.fromEntries(ERROR_LOG_FIELDS.flatMap((key) => {
      const value = record[key];
      return value === undefined ? [] : [[key, value]];
    }));
    return {
      message: error.message,
      stack: error.stack,
      name: error.name,
      ...fields,
      cause: serializeErrorForLog(error.cause),
    };
  }
  if (error === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(error));
  } catch {
    return String(error);
  }
};

app.notFound((c) => c.json({ message: "not found" }, 404));

app.onError((error, c) => {
  const requestId = c.get("requestId") ?? getOrCreateRequestId(c.req.header("x-request-id"));
  const ids = getActiveTraceIdentifiers(requestId);
  setRequestContextAttributes(trace.getActiveSpan(), ids);
  applyTraceResponseHeaders(c.res.headers, ids);

  const path = c.req.path;
  const method = c.req.method;
  logger.error(`[API Error] ${method} ${path} requestId=${requestId} traceId=${ids.traceId ?? "none"}:`, serializeErrorForLog(error));
  return c.json({ message: "internal server error", requestId, traceId: ids.traceId }, 500);
});

// ── Start server ─────────────────────────────────────────────────────────────

const port = Number(process.env.PORT ?? 8787);
assertRequiredConfig();
configureBillingRuntime({
  config,
  redis: (await import("./redis.js")).redisCommandClient,
});
const server = serve({
  fetch: app.fetch,
  port,
  serverOptions: {
    requestTimeout: 0,
    keepAliveTimeout: 75_000,
  },
});
server.setTimeout(0);
logger.info(`@cohub/api listening on :${port}`);
