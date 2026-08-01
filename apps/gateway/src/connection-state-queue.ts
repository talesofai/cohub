export type ConnectionStateQueue = {
  stateTail: Promise<void>;
  pendingStateOperations: number;
};

export const MAX_PENDING_CONNECTION_STATE_OPERATIONS = 64;

export class ConnectionStateQueueOverflowError extends Error {
  override name = "ConnectionStateQueueOverflowError";
}

export function enqueueConnectionState<T>(
  queue: ConnectionStateQueue,
  operation: () => Promise<T>,
  options: { allowWhenFull?: boolean; maxPending?: number } = {},
): Promise<T> {
  const maxPending = options.maxPending ?? MAX_PENDING_CONNECTION_STATE_OPERATIONS;
  if (!options.allowWhenFull && queue.pendingStateOperations >= maxPending) {
    return Promise.reject(new ConnectionStateQueueOverflowError("connection state queue is full"));
  }
  queue.pendingStateOperations += 1;
  const run = queue.stateTail.then(operation);
  const settled = run.finally(() => {
    queue.pendingStateOperations -= 1;
  });
  queue.stateTail = settled.then(() => undefined, () => undefined);
  return settled;
}
