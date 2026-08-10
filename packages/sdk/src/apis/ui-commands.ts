import type { HttpTransport } from "../transport.js";
import {
  isTerminalUiCommandStatus,
  UI_COMMAND_DEFAULT_TIMEOUT_MS,
  UI_COMMAND_MAX_TIMEOUT_MS,
  type UiCommand,
  type UiCommandError,
  type UiCommandRecord,
  type UiCommandStatus,
} from "@cohub/protocol/ui-command";

export type {
  UiCommand,
  UiCommandError,
  UiCommandRecord,
  UiCommandStatus,
  UiPreviewTarget,
  UiSurfaceRequest,
  UiWorkPreviewTarget,
} from "@cohub/protocol/ui-command";

export type CreateUiCommandInput = {
  command: UiCommand;
  commandId?: string;
  targetClientId?: string;
};

export type WaitForUiCommandOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
};

const DEFAULT_POLL_INTERVAL_MS = 300;

const resolveTimeoutMs = (timeoutMs: number | undefined): number => {
  const value = timeoutMs ?? UI_COMMAND_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0 || value > UI_COMMAND_MAX_TIMEOUT_MS) {
    throw new RangeError(
      `timeoutMs must be between 1 and ${UI_COMMAND_MAX_TIMEOUT_MS} milliseconds`,
    );
  }
  return value;
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export class UiCommandsApi {
  constructor(private readonly transport: HttpTransport) {}

  create(input: CreateUiCommandInput) {
    return this.transport.request<{ command: UiCommandRecord }>("/api/ui/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  get(commandId: string) {
    return this.transport.request<{ command: UiCommandRecord }>(
      `/api/ui/commands/${encodeURIComponent(commandId)}`,
    );
  }

  reportResult(
    commandId: string,
    input: { status: UiCommandStatus; result?: unknown; error?: UiCommandError | null },
  ) {
    return this.transport.request<{ command: UiCommandRecord }>(
      `/api/ui/commands/${encodeURIComponent(commandId)}/result`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  async run(
    input: CreateUiCommandInput,
    options: WaitForUiCommandOptions = {},
  ): Promise<UiCommandRecord> {
    const { command } = await this.create(input);
    if (isTerminalUiCommandStatus(command.status)) return command;
    return this.wait(command.commandId, options);
  }

  async wait(
    commandId: string,
    options: WaitForUiCommandOptions = {},
  ): Promise<UiCommandRecord> {
    const timeoutMs = resolveTimeoutMs(options.timeoutMs);
    const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const deadline = Date.now() + timeoutMs;
    let latest = (await this.get(commandId)).command;

    while (!isTerminalUiCommandStatus(latest.status)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(pollIntervalMs, remaining), options.signal);
      latest = (await this.get(commandId)).command;
    }
    if (isTerminalUiCommandStatus(latest.status)) return latest;

    return {
      ...latest,
      status: "timeout",
      error: {
        code: "timeout",
        message: "No Cohub frontend reported a result before the timeout.",
      },
      settledAt: new Date().toISOString(),
    };
  }
}
