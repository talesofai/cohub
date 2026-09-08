import { fileURLToPath } from "node:url";
import {
  LocalRuntimeProviderSchema,
  type LocalRuntimeProvider,
} from "@cohub/protocol";
import {
  createDefaultLocalRuntimeAdapter,
} from "./providers/index.js";
import {
  LocalRuntimeRunner,
  type LocalRuntimeRunnerError,
} from "./runner.js";
import type { LocalRuntimeRunnerOptions } from "./types.js";

export const LOCAL_RUNTIME_HOST_VERSION = "1.0.0";

export type LocalRuntimeHostOptions = Omit<LocalRuntimeRunnerOptions, "adapterFactory" | "input" | "output" | "endOutput"> & {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  adapterFactory?: LocalRuntimeRunnerOptions["adapterFactory"];
  endOutput?: boolean;
};

const text = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const positiveInteger = (value: string, name: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
};

function envProvider(): LocalRuntimeProvider | undefined {
  const value = text(process.env.COHUB_RUNTIME_PROVIDER);
  if (!value) return undefined;
  const parsed = LocalRuntimeProviderSchema.safeParse(value);
  if (!parsed.success) throw new Error(`COHUB_RUNTIME_PROVIDER must be one of: ${LocalRuntimeProviderSchema.options.join(", ")}`);
  return parsed.data;
}

/**
 * Construct a host with all native adapters. Identity can be supplied by the
 * relay/locald environment or learned from the first validated command.
 */
export function createLocalRuntimeHost(options: LocalRuntimeHostOptions = {}): LocalRuntimeRunner {
  const workspaceRoot = options.workspaceRoot?.trim()
    || text(process.env.COHUB_RUNTIME_CWD)
    || process.cwd();
  return new LocalRuntimeRunner({
    ...options,
    workspaceRoot,
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
    adapterFactory: options.adapterFactory ?? createDefaultLocalRuntimeAdapter,
    endOutput: options.endOutput ?? true,
  });
}

export function runLocalRuntimeHost(options: LocalRuntimeHostOptions = {}): Promise<void> {
  return createLocalRuntimeHost(options).run();
}

function usage(): string {
  return [
    "Usage: cohub-agent-runtime [options]",
    "",
    "Reads provider-neutral local-runtime commands from stdin and writes events to stdout.",
    "",
    "Options:",
    "  --runtime-id <id>       Pin the runtime identity",
    "  --space-id <id>         Pin the Space identity",
    "  --execution-attempt-id <id>  Pin the execution attempt identity",
    "  --provider <name>       Pin pi, codex, or claude_code",
    "  --connection-epoch <n>  Pin the relay connection epoch",
    "  --max-frame-bytes <n>   Override the input frame limit",
    "  --max-event-bytes <n>   Override the output event limit",
    "  --version               Show the runtime host version",
    "  -h, --help              Show this message",
  ].join("\n");
}

type ParsedCliOptions = {
  runtimeId?: string;
  spaceId?: string;
  executionAttemptId?: string;
  provider?: LocalRuntimeProvider;
  connectionEpoch?: number;
  maxFrameBytes?: number;
  maxEventBytes?: number;
  terminal?: "help" | "version";
};

function parseArgs(argv: readonly string[]): ParsedCliOptions {
  const result: ParsedCliOptions = {
    runtimeId: text(process.env.COHUB_RUNTIME_ID),
    spaceId: text(process.env.COHUB_SPACE_ID),
    executionAttemptId: text(process.env.COHUB_RUNTIME_EXECUTION_ATTEMPT_ID),
    provider: envProvider(),
    connectionEpoch: text(process.env.COHUB_RUNTIME_CONNECTION_EPOCH)
      ? positiveInteger(text(process.env.COHUB_RUNTIME_CONNECTION_EPOCH) as string, "connection epoch")
      : undefined,
  };
  const take = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${usage()}\n`);
      return { ...result, terminal: "help" };
    }
    if (arg === "--version") {
      process.stdout.write(`${LOCAL_RUNTIME_HOST_VERSION}\n`);
      return { ...result, terminal: "version" };
    }
    if (arg === "--runtime-id") { result.runtimeId = take(index, arg); index += 1; continue; }
    if (arg === "--space-id") { result.spaceId = take(index, arg); index += 1; continue; }
    if (arg === "--execution-attempt-id") { result.executionAttemptId = take(index, arg); index += 1; continue; }
    if (arg === "--provider") {
      const value = take(index, arg);
      const parsed = LocalRuntimeProviderSchema.safeParse(value);
      if (!parsed.success) throw new Error(`--provider must be one of: ${LocalRuntimeProviderSchema.options.join(", ")}`);
      result.provider = parsed.data;
      index += 1;
      continue;
    }
    if (arg === "--connection-epoch") { result.connectionEpoch = positiveInteger(take(index, arg), "connection epoch"); index += 1; continue; }
    if (arg === "--max-frame-bytes") { result.maxFrameBytes = positiveInteger(take(index, arg), "max frame bytes"); index += 1; continue; }
    if (arg === "--max-event-bytes") { result.maxEventBytes = positiveInteger(take(index, arg), "max event bytes"); index += 1; continue; }
    throw new Error(`unknown option: ${arg}`);
  }
  return result;
}

function logger() {
  const write = (level: string, message: string, details?: Record<string, unknown>) => {
    const suffix = details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : "";
    process.stderr.write(`[cohub-agent-runtime] ${level}: ${message}${suffix}\n`);
  };
  return {
    debug: (message: string, details?: Record<string, unknown>) => write("debug", message, details),
    info: (message: string, details?: Record<string, unknown>) => write("info", message, details),
    warn: (message: string, details?: Record<string, unknown>) => write("warn", message, details),
    error: (message: string, details?: Record<string, unknown>) => write("error", message, details),
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.terminal) return;
  const abort = new AbortController();
  const stop = () => abort.abort(new Error("local runtime host shutting down"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runLocalRuntimeHost({
      ...parsed,
      logger: logger(),
      signal: abort.signal,
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

const isEntrypoint = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return fileURLToPath(import.meta.url) === entry || fileURLToPath(import.meta.url) === `${entry}.js`; }
  catch { return false; }
})();

if (isEntrypoint) {
  void main().catch((error: LocalRuntimeRunnerError | Error) => {
    process.stderr.write(`[cohub-agent-runtime] error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
