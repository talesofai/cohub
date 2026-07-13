import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { works, workAssetReservations, workVersions } from "@cohub/db";
import { createLogger } from "@cohub/infra/logging";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import { ensureInternalRequest } from "../../lib/middleware.js";
import { deleteWorkAssetsByObjectKeys } from "../../work-asset-storage.js";
import {
  getWorkAssetReservationCleanupDecision,
  hasActiveWorkAssetWriterLease,
  shouldDeferWorkAssetCleanupForReferences,
} from "../../work-asset-reservation-state.js";
import { WorkAssetCleanupError, collectWorkAssetKeys, excludeReferencedWorkAssetKeys } from "../work-delete.js";

const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();
const WRITER_LEASE_MS = 2 * 60_000;

router.post("/writer-lease/:action", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;
  const action = c.req.param("action");
  if (!new Set(["acquire", "heartbeat", "release"]).has(action)) {
    return c.json({ ok: false, message: "writer lease action not found" }, 404);
  }
  const body = await c.req.json().catch(() => null) as {
    publishJobId?: unknown;
    writerId?: unknown;
  } | null;
  if (
    typeof body?.publishJobId !== "string" ||
    !body.publishJobId ||
    typeof body.writerId !== "string" ||
    !body.writerId
  ) {
    return c.json({ ok: false, message: "invalid work asset writer lease" }, 400);
  }

  if (action === "acquire") {
    const result = await db.transaction(async (tx) => {
      const [reservation] = await tx
        .select()
        .from(workAssetReservations)
        .where(eq(workAssetReservations.publishJobId, body.publishJobId as string))
        .limit(1)
        .for("update");
      if (!reservation) return "missing" as const;
      if (reservation.state !== "pending") return "closed" as const;
      if (
        reservation.writerId !== null &&
        reservation.writerId !== body.writerId &&
        hasActiveWorkAssetWriterLease(reservation.writerLeaseExpiresAt, Date.now())
      ) {
        return "busy" as const;
      }
      await tx
        .update(workAssetReservations)
        .set({
          writerId: body.writerId as string,
          writerLeaseExpiresAt: new Date(Date.now() + WRITER_LEASE_MS),
          updatedAt: new Date(),
        })
        .where(eq(workAssetReservations.publishJobId, reservation.publishJobId));
      return "acquired" as const;
    });
    if (result !== "acquired") {
      return c.json({ ok: false, message: `writer lease ${result}` }, result === "missing" ? 404 : 409);
    }
    return c.json({ ok: true, leaseMs: WRITER_LEASE_MS });
  }

  const writerConditions = [
    eq(workAssetReservations.publishJobId, body.publishJobId),
    eq(workAssetReservations.writerId, body.writerId),
  ];
  if (action === "heartbeat") {
    writerConditions.push(inArray(workAssetReservations.state, ["pending", "abandoned"]));
  }
  const [reservation] = await db
    .update(workAssetReservations)
    .set({
      writerId: action === "release" ? null : body.writerId,
      writerLeaseExpiresAt: action === "release" ? null : new Date(Date.now() + WRITER_LEASE_MS),
      updatedAt: new Date(),
    })
    .where(and(...writerConditions))
    .returning({ publishJobId: workAssetReservations.publishJobId });
  if (!reservation) return c.json({ ok: false, message: "writer lease lost" }, 409);
  return c.json({ ok: true, leaseMs: action === "release" ? 0 : WRITER_LEASE_MS });
});

router.post("/cleanup-assets", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const body = await c.req.json().catch(() => null) as {
    assetKeys?: unknown;
    scope?: { env?: unknown; spaceId?: unknown; slug?: unknown };
    reason?: unknown;
    publishJobId?: unknown;
    deferWhileReferenced?: unknown;
    claimant?: unknown;
  } | null;
  if (
    !Array.isArray(body?.assetKeys) ||
    body.assetKeys.length === 0 ||
    body.assetKeys.some((assetKey) => typeof assetKey !== "string") ||
    body.scope?.env !== config.env ||
    typeof body.scope?.spaceId !== "string" ||
    typeof body.scope.slug !== "string" ||
    typeof body.reason !== "string" ||
    !body.reason.trim() ||
    (body.deferWhileReferenced !== undefined && typeof body.deferWhileReferenced !== "boolean") ||
    (body.publishJobId !== undefined && (
      typeof body.publishJobId !== "string" ||
      !body.publishJobId ||
      typeof body.claimant !== "string" ||
      !body.claimant
    ))
  ) {
    return c.json({ ok: false, message: "invalid work asset cleanup job" }, 400);
  }

  try {
    const assetKeys = collectWorkAssetKeys(body.assetKeys as string[], {
      env: config.env,
      spaceId: body.scope.spaceId,
      slug: body.scope.slug,
    });
    const reservationResult = typeof body.publishJobId === "string"
      ? await db.transaction(async (tx) => {
        const [reservation] = await tx
          .select()
          .from(workAssetReservations)
          .where(eq(workAssetReservations.publishJobId, body.publishJobId as string))
          .limit(1)
          .for("update");
        if (!reservation) return { action: "retry" as const, reason: "reservation_missing" };
        if (
          assetKeys.length !== 1 ||
          reservation.assetKey !== assetKeys[0] ||
          reservation.spaceId !== body.scope.spaceId ||
          reservation.slug !== body.scope.slug
        ) {
          throw new WorkAssetCleanupError([
            { assetKey: assetKeys[0] ?? "", message: "work asset reservation does not match cleanup scope" },
          ]);
        }
        if (hasActiveWorkAssetWriterLease(reservation.writerLeaseExpiresAt, Date.now())) {
          return { action: "retry" as const, reason: "writer_lease_active" };
        }
        const decision = getWorkAssetReservationCleanupDecision(
          reservation.state,
          reservation.leaseExpiresAt.getTime(),
          Date.now(),
        );
        if (decision === "skip") return { action: "skip" as const };
        if (decision === "retry") return { action: "retry" as const, reason: "reservation_pending" };
        await tx
          .update(workAssetReservations)
          .set({
            state: "claimed",
            claimant: body.claimant as string,
            writerId: null,
            writerLeaseExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(eq(workAssetReservations.publishJobId, reservation.publishJobId));
        return { action: "delete" as const, publishJobId: reservation.publishJobId };
      })
      : { action: "delete" as const, publishJobId: null };

    if (reservationResult.action === "retry") {
      return c.json({ ok: false, message: reservationResult.reason, code: "work_asset_cleanup_deferred" }, 409);
    }
    if (reservationResult.action === "skip") {
      return c.json({ ok: true, deleted: 0, skippedReferenced: assetKeys.length });
    }

    const versionReferences = await db
      .select({ assetKey: workVersions.assetKey })
      .from(workVersions)
      .where(inArray(workVersions.assetKey, assetKeys));
    const workReferences = await db
      .select({ assetKey: works.assetKey })
      .from(works)
      .where(inArray(works.assetKey, assetKeys));
    const unreferencedAssetKeys = excludeReferencedWorkAssetKeys(
      assetKeys,
      [...versionReferences, ...workReferences].map((reference) => reference.assetKey),
    );
    if (shouldDeferWorkAssetCleanupForReferences(
      body.deferWhileReferenced === true,
      assetKeys.length,
      unreferencedAssetKeys.length,
    )) {
      return c.json({
        ok: false,
        message: "work asset cleanup is waiting for database references to detach",
        code: "work_asset_cleanup_deferred",
      }, 409);
    }
    if (unreferencedAssetKeys.length === 0) {
      if (reservationResult.publishJobId) {
        await db
          .update(workAssetReservations)
          .set({ state: "committed", updatedAt: new Date() })
          .where(eq(workAssetReservations.publishJobId, reservationResult.publishJobId));
      }
      return c.json({ ok: true, deleted: 0, skippedReferenced: assetKeys.length });
    }

    const deleted = await deleteWorkAssetsByObjectKeys(unreferencedAssetKeys);
    if (reservationResult.publishJobId) {
      await db
        .update(workAssetReservations)
        .set({ state: "cleaned", updatedAt: new Date() })
        .where(eq(workAssetReservations.publishJobId, reservationResult.publishJobId));
    }
    return c.json({
      ok: true,
      deleted: deleted.deleted,
      skippedReferenced: assetKeys.length - unreferencedAssetKeys.length,
    });
  } catch (error) {
    if (error instanceof WorkAssetCleanupError) {
      return c.json({ ok: false, message: error.message, code: "work_asset_cleanup_invalid" }, 400);
    }
    logger.error("[works] durable asset cleanup failed", {
      spaceId: body.scope.spaceId,
      slug: body.scope.slug,
      reason: body.reason,
      error,
    });
    return c.json({ ok: false, message: "work asset cleanup failed" }, 502);
  }
});

export default router;
