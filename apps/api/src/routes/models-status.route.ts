import { createLogger } from "@cohub/infra/logging";
import { Hono } from "hono";
import type { ModelStatusResponse } from "@cohub/protocol/model/status";
import { config } from "../config.js";
import { useAuth } from "../lib/middleware.js";
import {
  buildModelStatusResponse,
  type RawStatus,
} from "../model-status-transform.js";
import { redisCommandClient } from "../redis.js";

const logger = createLogger({ serviceName: "cohub-api" });

/**
 * Redis-cached, slimmed view of per-model availability derived from the
 * optional router-status service. router-status publishes model health,
 * observed traffic, and probe history; the multi-megabyte payload carries
 * raw per-probe samples we don't need; we cache only the aggregated fields the
 * UI consumes (~10–15KB). TTL matches the probe cadence so freshness is
 * never worse than fetching directly.
 */
const STATUS_REDIS_KEY = "configs:models-status:v2";
const STATUS_CACHE_TTL_SEC = 30;

let inflightPromise: Promise<ModelStatusResponse> | null = null;

async function fetchUpstream(): Promise<ModelStatusResponse> {
	const routerStatusUrl = config.routerStatusUrl;
	if (!routerStatusUrl) throw new Error("ROUTER_STATUS_URL is not configured");
	const res = await fetch(routerStatusUrl, {
		headers: { accept: "application/json" },
	});
	if (!res.ok) {
		throw new Error(`router-status upstream returned ${res.status}`);
	}
	const raw = (await res.json()) as RawStatus;

	const response = buildModelStatusResponse(raw);

	await redisCommandClient.set(
		STATUS_REDIS_KEY,
		JSON.stringify(response),
		"EX",
		STATUS_CACHE_TTL_SEC,
	);
	return response;
}

async function loadStatus(): Promise<ModelStatusResponse> {
	if (!config.routerStatusUrl) throw new Error("ROUTER_STATUS_URL is not configured");
	if (inflightPromise) return inflightPromise;

	const promise = (async () => {
		const cached = await redisCommandClient.get(STATUS_REDIS_KEY);
		if (cached) {
			try {
				return JSON.parse(cached) as ModelStatusResponse;
			} catch {
				// fall through to upstream
			}
		}
		return fetchUpstream();
	})();

	inflightPromise = promise;
	try {
		return await promise;
	} finally {
		if (inflightPromise === promise) inflightPromise = null;
	}
}

const router = new Hono();

router.get("/", async (c) => {
	const user = useAuth(c);
	if (user instanceof Response) return user;

	if (!config.routerStatusUrl) {
		return c.json({ message: "model status is not configured; set ROUTER_STATUS_URL" }, 503);
	}

	try {
		return c.json(await loadStatus());
	} catch (error) {
		logger.error("[models-status] failed to load", error);
		return c.json({ message: "failed to load model status" }, 502);
	}
});

export default router;
