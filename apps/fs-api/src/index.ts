import "dotenv/config";
import "./tracing.js";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { httpInstrumentationMiddleware } from "@hono/otel";
import { trace } from "@opentelemetry/api";
import { createLogger } from "@cohub/infra/logging";
import { applyTraceResponseHeaders, getActiveTraceIdentifiers, getOrCreateRequestId, runWithRequestTraceContext, setRequestContextAttributes } from "@cohub/infra/tracing";
import {
  createTokenAuth,
  createPermissionChecker,
  getOptionalAuth,
  useAuth,
  requireValidId,
  authzDenied,
  UnauthorizedError,
  type AuthUser,
  type RequestPrincipal,
} from "@cohub/core/auth";
import { createSpaceFsModule, createFsRouter, createCheckpointFsRouter, type FsRouterAuth } from "@cohub/space-fs";
import { assertRequiredConfig, config } from "./config.js";
import { db } from "./db/index.js";
import { redisCommandClient } from "./redis.js";

const logger = createLogger({ serviceName: "cohub-fs-api" });

assertRequiredConfig();

const tokenAuth = createTokenAuth({
  appEncryptionKey: config.appEncryptionKey,
  logtoEndpoint: config.logtoEndpoint,
});

const permissionChecker = createPermissionChecker({ db });

const spaceFsModule = createSpaceFsModule({
  config,
  db,
  redis: redisCommandClient,
  serviceName: "cohub-fs-api",
});

const auth: FsRouterAuth<AuthUser> = {
  getOptionalAuth,
  useAuth,
  requireValidId,
  authzDenied,
  hasPermission: (user, permission, ctx) => permissionChecker.hasPermission(user, permission, ctx),
};

const fsRouter = createFsRouter(spaceFsModule, auth);
const checkpointFsRouter = createCheckpointFsRouter(spaceFsModule, auth);

const app = new Hono<{
  Variables: {
    principal: RequestPrincipal | null;
    requestId: string;
    traceId: string | null;
  };
}>();

app.use(
  "*",
  httpInstrumentationMiddleware({
    serviceName: "cohub-fs-api",
    serviceVersion: process.env.IMAGE_TAG ?? "latest",
    captureRequestHeaders: ["authorization"],
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
    allowHeaders: ["Content-Type", "Authorization", "X-Request-Id", "Traceparent", "Tracestate", "Baggage", "Sentry-Trace"],
    exposeHeaders: ["X-Request-Id", "Traceparent", "Tracestate", "Baggage"],
    credentials: true,
  }),
);

app.use(tokenAuth.authMiddleware);

app.get("/healthz", (c) => c.json({ ok: true }));
app.get("/readyz", (c) => c.json({ ok: true }));

app.route("/api/spaces", fsRouter);
app.route("/api/spaces", checkpointFsRouter);

app.notFound((c) => c.json({ message: "not found" }, 404));

app.onError((error, c) => {
  const requestId = c.get("requestId") ?? getOrCreateRequestId(c.req.header("x-request-id"));
  const ids = getActiveTraceIdentifiers(requestId);
  setRequestContextAttributes(trace.getActiveSpan(), ids);
  applyTraceResponseHeaders(c.res.headers, ids);

  if (error instanceof UnauthorizedError) {
    return c.json({ message: error.message, requestId, traceId: ids.traceId }, 401);
  }
  const path = c.req.path;
  const method = c.req.method;
  logger.error(`[FS-API Error] ${method} ${path} requestId=${requestId} traceId=${ids.traceId ?? "none"}:`, error);
  return c.json({ message: "internal server error", requestId, traceId: ids.traceId }, 500);
});

const port = Number(process.env.PORT ?? 8789);
const server = serve({
  fetch: app.fetch,
  port,
  serverOptions: {
    requestTimeout: 0,
    keepAliveTimeout: 75_000,
  },
});
server.setTimeout(0);
logger.info(`@cohub/fs-api listening on :${port}`);
