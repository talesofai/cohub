/**
 * Lifecycle opens are scoped to the durable runtime session rather than to a
 * single execution attempt. A worker may need to activate the same native
 * session again after the previous attempt's locald process was reaped. All
 * other commands are attempt-scoped and must never be rebound to a retry.
 */
export function commandMayReuseExecutionAttempt(operation: string): boolean {
  return operation === "session.open";
}
