export type LockDbConnection = {
  release: () => void;
  unsafe: <T extends unknown[]>(query: string, parameters?: unknown[]) => PromiseLike<T>;
};

export type LockDbClient = {
  reserve: () => Promise<LockDbConnection>;
  end: (options?: { timeout?: number }) => Promise<void>;
};

export type LockDbLease = {
  connection: LockDbConnection;
  release: () => Promise<void>;
  discard: () => Promise<void>;
};

type Slot = {
  client: LockDbClient | null;
  busy: boolean;
};

type Waiter = {
  resolve: (slot: Slot) => void;
  reject: (error: Error) => void;
};

/**
 * A bounded pool of one-connection clients for PostgreSQL session locks.
 *
 * Each slot owns one client with max=1, so a reserved connection never shares
 * a session with unrelated work. A failed unlock retires the slot's client;
 * the next acquisition creates a replacement instead of returning an unknown
 * connection to the pool.
 */
export class LockDbPool {
  private readonly slots: Slot[];
  private readonly waiters: Waiter[] = [];
  private closed = false;

  constructor(
    private readonly createClient: () => LockDbClient,
    max: number,
  ) {
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new Error("lock database pool size must be a positive integer");
    }
    this.slots = Array.from({ length: max }, () => ({ client: null, busy: false }));
  }

  private takeSlot(): Slot | null {
    const slot = this.slots.find((candidate) => !candidate.busy) ?? null;
    if (slot) slot.busy = true;
    return slot;
  }

  private pump() {
    if (this.closed) return;
    while (this.waiters.length > 0) {
      const slot = this.takeSlot();
      if (!slot) return;
      const waiter = this.waiters.shift();
      if (!waiter) {
        slot.busy = false;
        return;
      }
      waiter.resolve(slot);
    }
  }

  private async closeSlotClient(slot: Slot, timeout: number) {
    const client = slot.client;
    slot.client = null;
    await client?.end({ timeout }).catch(() => undefined);
  }

  async acquire(): Promise<LockDbLease> {
    if (this.closed) throw new Error("lock database pool is closed");
    const slot = this.takeSlot() ?? await new Promise<Slot>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
    if (this.closed) {
      slot.busy = false;
      await this.closeSlotClient(slot, 0);
      throw new Error("lock database pool is closed");
    }

    try {
      let client = slot.client;
      if (!client) {
        client = this.createClient();
        slot.client = client;
      }
      const connection = await client.reserve();
      if (this.closed) {
        connection.release();
        await this.closeSlotClient(slot, 0);
        slot.busy = false;
        throw new Error("lock database pool is closed");
      }

      let finished = false;
      const finish = async (discard: boolean) => {
        if (finished) return;
        finished = true;
        let releaseError: unknown = null;
        try {
          // Release the reserved handle before ending its client. This is
          // required by postgres.js for a reserved connection to terminate.
          try {
            connection.release();
          } catch (error) {
            releaseError = error;
          }
          if (discard || this.closed || releaseError) await this.closeSlotClient(slot, 0);
        } finally {
          slot.busy = false;
          this.pump();
        }
        // discard() is cleanup for an already-failing path. release() still
        // reports a handle failure, after retiring the affected client.
        if (releaseError && !discard) throw releaseError;
      };
      return {
        connection,
        release: () => finish(false),
        discard: () => finish(true),
      };
    } catch (error) {
      await this.closeSlotClient(slot, 0);
      slot.busy = false;
      this.pump();
      throw error;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("lock database pool is closed");
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    await Promise.all(this.slots.map(async (slot) => {
      if (slot.busy) return;
      await this.closeSlotClient(slot, 5);
    }));
  }
}
