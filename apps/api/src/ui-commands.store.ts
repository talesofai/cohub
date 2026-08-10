/**
 * Mailbox Redis access, free of the client import so it can be tested with a fake.
 * Both writes are atomic Lua because reports genuinely race; `GET` then `SET`
 * would let the loser overwrite the winner.
 */

import {
  type UiCommandRecord,
  UI_COMMAND_PENDING_TTL_SECONDS,
  UI_COMMAND_TERMINAL_TTL_SECONDS,
} from "@cohub/protocol/ui-command";

export type UiCommandStoreClient = {
  eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
};

const UI_COMMAND_PREFIX = "cohub:ui:command";

export const getUiCommandKey = (commandId: string) => `${UI_COMMAND_PREFIX}:${commandId}`;

const CLAIM_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return {0, existing}
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return {1, ARGV[1]}
`;

/**
 * `actorUserId` is the security boundary; it comes from the session. The
 * `targetClientId` match only orders the user's own tabs, since `clientId` is a
 * client-supplied header.
 *
 * Returns `{ code, record }`: 1 settled, 0 already settled, -1 missing, -2 forbidden.
 */
const SETTLE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return {-1, ''}
end
local record = cjson.decode(raw)
if record['actorUserId'] ~= ARGV[1] then
  return {-2, ''}
end
local target = record['targetClientId']
if target and target ~= '' and target ~= ARGV[2] then
  return {-2, ''}
end
if record['settledAt'] and record['settledAt'] ~= cjson.null then
  return {0, raw}
end
redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
return {1, ARGV[3]}
`;

export type UiCommandSettleReason = "not_found" | "forbidden" | "already_settled";

export type UiCommandSettleOutcome =
  | { ok: true; record: UiCommandRecord }
  | { ok: false; reason: UiCommandSettleReason; record?: UiCommandRecord };

const parseRecord = (raw: string | null): UiCommandRecord | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UiCommandRecord;
  } catch {
    return null;
  }
};

export class UiCommandStoreError extends Error {
  constructor(detail: string) {
    super(`ui command store returned an unusable value: ${detail}`);
    this.name = "UiCommandStoreError";
  }
}

/** Throws rather than guessing: dispatching an unpersisted command guarantees a timeout. */
const readScriptResult = (value: unknown): { code: number; record: UiCommandRecord | null } => {
  const pair = Array.isArray(value) ? value : [];
  const code = Number(pair[0]);
  if (!Number.isFinite(code)) throw new UiCommandStoreError(`code ${String(pair[0])}`);
  const raw = typeof pair[1] === "string" && pair[1] ? pair[1] : null;
  const record = parseRecord(raw);
  if (raw && !record) throw new UiCommandStoreError("record is not valid JSON");
  return { code, record };
};

export async function readUiCommand(
  client: UiCommandStoreClient,
  commandId: string,
): Promise<UiCommandRecord | null> {
  return parseRecord(await client.get(getUiCommandKey(commandId)));
}

export async function claimUiCommand(
  client: UiCommandStoreClient,
  record: UiCommandRecord,
): Promise<{ claimed: boolean; record: UiCommandRecord }> {
  const result = readScriptResult(
    await client.eval(
      CLAIM_SCRIPT,
      1,
      getUiCommandKey(record.commandId),
      JSON.stringify(record),
      String(record.settledAt ? UI_COMMAND_TERMINAL_TTL_SECONDS : UI_COMMAND_PENDING_TTL_SECONDS),
    ),
  );
  if (result.code === 1) return { claimed: true, record: result.record ?? record };
  if (!result.record) throw new UiCommandStoreError("claim lost without a stored record");
  return { claimed: false, record: result.record };
}

export async function settleUiCommandRecord(
  client: UiCommandStoreClient,
  input: {
    commandId: string;
    actorUserId: string;
    reportingClientId: string | null;
    next: (current: UiCommandRecord) => UiCommandRecord;
  },
): Promise<UiCommandSettleOutcome> {
  const current = await readUiCommand(client, input.commandId);
  if (!current) return { ok: false, reason: "not_found" };

  const result = readScriptResult(
    await client.eval(
      SETTLE_SCRIPT,
      1,
      getUiCommandKey(input.commandId),
      input.actorUserId,
      input.reportingClientId ?? "",
      JSON.stringify(input.next(current)),
      String(UI_COMMAND_TERMINAL_TTL_SECONDS),
    ),
  );

  if (result.code === 1 && result.record) return { ok: true, record: result.record };
  if (result.code === 0) {
    return {
      ok: false,
      reason: "already_settled",
      ...(result.record ? { record: result.record } : {}),
    };
  }
  if (result.code === -2) return { ok: false, reason: "forbidden" };
  return { ok: false, reason: "not_found" };
}
