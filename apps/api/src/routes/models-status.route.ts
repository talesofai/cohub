import { createLogger } from "@cohub/infra/logging";
import { Hono } from "hono";
import type {
  ModelAvailabilityStatus,
  ModelStatusEntry,
  ModelStatusResponse,
} from "@cohub/protocol/model/status";
import { config } from "../config.js";
import { useAuth } from "../lib/middleware.js";
import { redisCommandClient } from "../redis.js";

const logger = createLogger({ serviceName: "cohub-api" });

/**
 * Redis-cached, slimmed view of per-model availability derived from the
 * router-status probe service. The upstream payload (~870KB) carries raw
 * per-probe samples we don't need; we cache only the aggregated fields the
 * UI consumes (~10–15KB). TTL matches the probe cadence so freshness is
 * never worse than fetching directly.
 */
const STATUS_REDIS_KEY = "configs:models-status:v1";
const STATUS_CACHE_TTL_SEC = 30;
/** Primary probe instance; others are fallbacks per model id. */
const PRIMARY_INSTANCE = "neta";

let inflightPromise: Promise<ModelStatusResponse> | null = null;

type RawCheck = {
	model: string;
	instance?: string;
	status: string;
	checked_at?: string;
	probe_interval_seconds?: number;
	latency_1h?: {
		sample_count?: number;
		average_duration_ms?: number;
		p90_duration_ms?: number;
	};
	windows?: Record<
		string,
		{
			sample_count?: number;
			operational_samples?: number;
			outage_samples?: number;
			success_rate?: number;
		}
	>;
	history?: Array<{
		started_at?: string;
		status?: string;
		sample_count?: number;
		operational_samples?: number;
	}>;
};

type RawOnlineHeartbeat = {
	start?: string;
	success_rate?: number;
	sample_count?: number;
};

type RawOnlineModel = {
	model: string;
	heartbeats?: RawOnlineHeartbeat[];
};

type RawOnline = {
	window?: { start?: string; minutes?: number };
	models?: RawOnlineModel[];
};

type RawStatus = {
	generated_at?: string;
	overall_status?: string;
	checks?: RawCheck[];
	online?: RawOnline;
};

function normalizeStatus(value: string | undefined): ModelAvailabilityStatus {
	if (value === "operational" || value === "degraded" || value === "outage") return value;
	return "operational";
}

function windowRate(
	windows: RawCheck["windows"],
	key: string,
): number | null {
	const w = windows?.[key];
	if (!w?.sample_count) return null;
	return typeof w.success_rate === "number" ? w.success_rate : null;
}

/** 24h uptime from history buckets; null if no usable samples. */
function uptime24h(history: RawCheck["history"]): number | null {
	if (!history?.length) return null;
	let op = 0;
	let total = 0;
	for (const b of history) {
		const sc = b.sample_count ?? 0;
		total += sc;
		op += b.operational_samples ?? 0;
	}
	return total > 0 ? (op / total) * 100 : null;
}

function slimCheck(
	c: RawCheck,
	heartbeats8h: Array<number | null> | null,
	heartbeatsWindowMinutes: number | null,
): ModelStatusEntry {
	const windows = c.windows ?? {};
	const l = c.latency_1h;
	return {
		status: normalizeStatus(c.status),
		successRate5m: windowRate(windows, "5m"),
		successRate2h: windowRate(windows, "2h"),
		successRate24h: uptime24h(c.history),
		latencyAvgMs: l?.average_duration_ms ?? null,
		latencyP90Ms: l?.p90_duration_ms ?? null,
		samples1h: l?.sample_count ?? null,
		checkedAt: c.checked_at ?? null,
		probeIntervalSeconds: c.probe_interval_seconds ?? null,
		heartbeats8h,
		heartbeatsWindowMinutes,
		history: c.history?.length
			? c.history.map((b) => ({
					t: b.started_at ?? "",
					status: normalizeStatus(b.status),
					rate: b.sample_count ? ((b.operational_samples ?? 0) / b.sample_count) * 100 : null,
					samples: b.sample_count ?? 0,
				}))
			: null,
	};
}

async function fetchUpstream(): Promise<ModelStatusResponse> {
	const res = await fetch(config.routerStatusUrl, {
		headers: { accept: "application/json" },
	});
	if (!res.ok) {
		throw new Error(`router-status upstream returned ${res.status}`);
	}
	const raw = (await res.json()) as RawStatus;

	// Primary instance wins; fallbacks only fill gaps per model id.
	const byModel = new Map<string, RawCheck>();
	for (const c of raw.checks ?? []) {
		const existing = byModel.get(c.model);
		if (!existing || (c.instance === PRIMARY_INSTANCE && existing.instance !== PRIMARY_INSTANCE)) {
			byModel.set(c.model, c);
		}
	}

	// 8h online heartbeats arrive as 2-min buckets (~240) — too dense for the
	// 288px hover card (gaps alone would overflow). Resample to 5-min buckets
	// (96 bars over 8h), matching the validated bar density. Each 5-min bucket
	// is the sample-weighted mean success rate of the 2-min buckets it covers;
	// empty buckets stay null (rendered gray).
	const HEARTBEAT_BUCKET_MS = 5 * 60 * 1000;
	const windowStartMs = raw.online?.window?.start
		? Date.parse(raw.online.window.start)
		: Number.NaN;
	const windowMinutes = raw.online?.window?.minutes ?? 480;
	const heartbeatBucketCount = Math.max(1, Math.round(windowMinutes / 5));

	function resampleHeartbeats(heartbeats: RawOnlineHeartbeat[]): Array<number | null> | null {
		if (!Number.isFinite(windowStartMs) || !heartbeats.length) return null;
		const acc = new Map<number, { sum: number; weight: number }>();
		for (const hb of heartbeats) {
			const t = hb.start ? Date.parse(hb.start) : Number.NaN;
			if (!Number.isFinite(t) || typeof hb.success_rate !== "number") continue;
			const idx = Math.floor((t - windowStartMs) / HEARTBEAT_BUCKET_MS);
			if (idx < 0 || idx >= heartbeatBucketCount) continue;
			const w = hb.sample_count && hb.sample_count > 0 ? hb.sample_count : 1;
			const slot = acc.get(idx) ?? { sum: 0, weight: 0 };
			slot.sum += hb.success_rate * w;
			slot.weight += w;
			acc.set(idx, slot);
		}
		const out: Array<number | null> = [];
		for (let i = 0; i < heartbeatBucketCount; i++) {
			const slot = acc.get(i);
			out.push(slot && slot.weight > 0 ? Math.round((slot.sum / slot.weight) * 10) / 10 : null);
		}
		return out;
	}

	const onlineModels = raw.online?.models ?? [];
	const onlineHeartbeatsByModel = new Map<string, Array<number | null> | null>();
	for (const m of onlineModels) {
		onlineHeartbeatsByModel.set(m.model, m.heartbeats ? resampleHeartbeats(m.heartbeats) : null);
	}
	const onlineWindowMinutes = windowMinutes;
	const HISTORY_WINDOW_MINUTES = 24 * 60;

	// Per-model bar series: real observed traffic (online) first; fall back to
	// the probe self-test history for models not yet covered by online (new
	// models, or a stale/missing online snapshot). Each branch yields 96
	// buckets; windowMinutes tags the source so the axis label stays honest.
	function historyRates(c: RawCheck): Array<number | null> {
		return (c.history ?? []).map((b) =>
			b.sample_count ? Math.round(((b.operational_samples ?? 0) / b.sample_count) * 100) : null,
		);
	}

	const models: Record<string, ModelStatusEntry> = {};
	for (const [id, c] of byModel) {
		const online = onlineHeartbeatsByModel.get(id) ?? null;
		if (online?.some((r) => r != null)) {
			models[id] = slimCheck(c, online, onlineWindowMinutes);
		} else {
			models[id] = slimCheck(c, historyRates(c), HISTORY_WINDOW_MINUTES);
		}
	}

	const overall = raw.overall_status;
	const response: ModelStatusResponse = {
		generatedAt: raw.generated_at ?? new Date().toISOString(),
		overallStatus:
			overall === "operational" || overall === "degraded" || overall === "outage"
				? overall
				: "unknown",
		models,
	};

	await redisCommandClient.set(
		STATUS_REDIS_KEY,
		JSON.stringify(response),
		"EX",
		STATUS_CACHE_TTL_SEC,
	);
	return response;
}

async function loadStatus(): Promise<ModelStatusResponse> {
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

	try {
		return c.json(await loadStatus());
	} catch (error) {
		logger.error("[models-status] failed to load", error);
		return c.json({ message: "failed to load model status" }, 502);
	}
});

export default router;
