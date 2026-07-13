import { and, eq, inArray } from "drizzle-orm";
import { workAssetReservations } from "@cohub/db";
import { db } from "./db/index.js";

const RESERVATION_LEASE_MS = 2 * 60_000;
const RESERVATION_HEARTBEAT_MS = 30_000;

export async function startWorkAssetReservation(input: {
  publishJobId: string;
  assetKey: string;
  spaceId: string;
  slug: string;
}) {
  await db.insert(workAssetReservations).values({
    ...input,
    state: "pending",
    leaseExpiresAt: new Date(Date.now() + RESERVATION_LEASE_MS),
  });

  let healthy = true;
  let stopped = false;
  let heartbeatInFlight: Promise<void> = Promise.resolve();

  const refresh = async () => {
    const [reservation] = await db
      .update(workAssetReservations)
      .set({
        leaseExpiresAt: new Date(Date.now() + RESERVATION_LEASE_MS),
        updatedAt: new Date(),
      })
      .where(and(
        eq(workAssetReservations.publishJobId, input.publishJobId),
        eq(workAssetReservations.state, "pending"),
      ))
      .returning({ publishJobId: workAssetReservations.publishJobId });
    if (!reservation) throw new Error("work asset reservation is no longer pending");
  };

  const timer = setInterval(() => {
    if (stopped) return;
    heartbeatInFlight = refresh().catch((error) => {
      healthy = false;
      throw error;
    });
    heartbeatInFlight.catch(() => undefined);
  }, RESERVATION_HEARTBEAT_MS);
  timer.unref();

  const stopHeartbeat = async () => {
    stopped = true;
    clearInterval(timer);
    await heartbeatInFlight.catch(() => undefined);
  };

  return {
    publishJobId: input.publishJobId,
    async assertHealthy() {
      await heartbeatInFlight.catch(() => undefined);
      if (!healthy) throw new Error("work asset reservation heartbeat failed");
      await refresh();
    },
    async stop() {
      await stopHeartbeat();
    },
    async abandon() {
      await stopHeartbeat();
      const [reservation] = await db
        .update(workAssetReservations)
        .set({ state: "abandoned", updatedAt: new Date() })
        .where(and(
          eq(workAssetReservations.publishJobId, input.publishJobId),
          eq(workAssetReservations.state, "pending"),
        ))
        .returning({ publishJobId: workAssetReservations.publishJobId });
      if (!reservation) throw new Error("failed to abandon work asset reservation");
    },
  };
}

export async function markWorkAssetReservationCleaned(publishJobId: string) {
  const [reservation] = await db
    .update(workAssetReservations)
    .set({ state: "cleaned", updatedAt: new Date() })
    .where(and(
      eq(workAssetReservations.publishJobId, publishJobId),
      inArray(workAssetReservations.state, ["abandoned", "claimed"]),
    ))
    .returning({ publishJobId: workAssetReservations.publishJobId });
  if (!reservation) throw new Error("failed to complete work asset reservation cleanup");
}
