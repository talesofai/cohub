import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { resolveCohubEnvironment, resolveWebsocketUrl } from "@neta-art/cohub";
import type { Command } from "commander";
import { requireAccessToken } from "../auth.js";
import { createClient } from "../client.js";
import { error, json as outJson, jsonRequested, ok, spinner } from "../output.js";
import { resolveSpace } from "../space.js";
import { ensureSandboxdBinary, SandboxdDownloadError } from "./sandboxd-binary.js";

type UpOptions = {
  space?: string;
  name?: string;
  json?: boolean;
  yes?: boolean;
};

// Derive the gateway relay control endpoint from the realtime websocket URL,
// e.g. wss://gateway.cohub.run/ws -> wss://gateway.cohub.run/sandbox/relay.
const resolveRelayUrl = (): string => {
  const explicit = process.env.COHUB_RELAY_URL?.trim();
  if (explicit) return explicit;
  const wsUrl = resolveWebsocketUrl({ url: process.env.COHUB_WS_URL });
  return wsUrl.replace(/\/ws$/, "/sandbox/relay");
};

const confirm = async (question: string): Promise<boolean> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((res) => rl.question(`${question} [y/N] `, res));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
};

const webBaseUrl = (): string =>
  resolveCohubEnvironment() === "prod" ? "https://cohub.run" : "https://dev.cohub.run";

// Consent copy is deliberately explicit: a local sandbox runs agent-issued
// shell commands as the current OS user. File RPCs are fenced to the folder,
// but shell commands are NOT — they can read/write anything the user can
// (SSH keys, other repos, etc). This mirrors the trust model of running an
// AI coding agent locally and must be surfaced clearly before starting.
const consentMessage = (rootDir: string, target: string): string =>
  [
    `Start ${target} exposing ${rootDir}?`,
    "",
    "Agents in this space will be able to:",
    `  • read and write files under ${rootDir}`,
    "  • run shell commands as your user (full access to your machine, not just this folder)",
    "",
    "Only continue if you trust this space's collaborators.",
  ].join("\n");

export function registerSandbox(program: Command): void {
  const cmd = program.command("sandbox").description("Run a local folder as a space sandbox");

  // ── sandbox up ──
  cmd
    .command("up [dir]")
    .description("Expose a local folder to a space as its sandbox (foreground; Ctrl-C to stop)")
    .option("-s, --space <id>", "Bind to an existing space instead of creating one")
    .option("-n, --name <name>", "Name for the newly created space")
    .option("-y, --yes", "Skip the confirmation prompt")
    .option("--json", "Output as JSON")
    .action(async (dir: string | undefined, opts: UpOptions) => {
      const rootDir = resolve(dir ?? process.cwd());
      const info = await stat(rootDir).catch(() => null);
      if (!info?.isDirectory()) {
        return error("Invalid directory", `${rootDir} is not a directory`);
      }

      // A single spinner: first status starts it, later statuses only update the
      // label (calling start twice would leak the previous interval).
      const spin = spinner();
      let spinnerStarted = false;
      let binary: string;
      try {
        binary = await ensureSandboxdBinary({
          onStatus: (msg) => {
            if (spinnerStarted) {
              spin.update(msg);
            } else {
              spin.start(msg);
              spinnerStarted = true;
            }
          },
        });
        if (spinnerStarted) spin.stop("");
      } catch (err) {
        if (spinnerStarted) spin.stop("");
        if (err instanceof SandboxdDownloadError) return error("Sandbox runtime unavailable", err.message);
        throw err;
      }
      const relayUrl = resolveRelayUrl();
      const token = await requireAccessToken();
      const client = createClient();

      // Resolve or create the target space.
      let spaceId = opts.space?.trim() || (program.opts().space as string | undefined)?.trim();
      if (!spaceId) {
        if (!opts.yes) {
          const proceed = await confirm(consentMessage(rootDir, "a new local space"));
          if (!proceed) return error("Aborted", "No space was created");
        }
        const created = await client.spaces.create({
          name: opts.name,
          config: { sandbox: { provider: "local" } },
        });
        spaceId = created.space.id;
        ok(`Created local space ${spaceId}`);
      } else {
        // A local runner can only attach to a space whose sandbox provider is
        // "local" (provider is fixed at space creation). Fail early with a clear
        // message instead of letting the gateway reject the connection later.
        const existing = await client.space(spaceId).sandbox.get().catch(() => null);
        if (existing?.sandbox?.provider !== "local") {
          return error(
            "Not a local space",
            `Space ${spaceId} is not configured for a local sandbox. Create one with 'cohub sandbox up' (without --space).`,
          );
        }
        if (!opts.yes) {
          const proceed = await confirm(consentMessage(rootDir, `space ${spaceId}`));
          if (!proceed) return error("Aborted", "Sandbox was not started");
        }
      }

      const url = `${webBaseUrl()}/spaces/${spaceId}`;
      if (jsonRequested(opts)) {
        outJson({ spaceId, rootDir, relayUrl, url });
      } else {
        ok(`Sandbox ready — open ${url}`);
        console.log(`  Serving: ${rootDir}`);
        console.log("  Press Ctrl-C to stop.\n");
      }

      // Spawn the runner in the foreground. It dials the gateway relay and
      // stays connected until the process is interrupted.
      const child = spawn(
        binary,
        ["--local", "--space", spaceId, "--root", rootDir, "--relay", relayUrl],
        {
          stdio: ["ignore", "inherit", "inherit"],
          env: { ...process.env, COHUB_RELAY_TOKEN: token },
        },
      );

      const stop = () => child.kill("SIGTERM");
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);

      await new Promise<void>((res) => {
        child.on("exit", (code, signal) => {
          if (signal) console.log(`\nSandbox stopped (${signal}).`);
          else if (code !== 0) console.error(`Sandbox exited with code ${code}.`);
          res();
        });
        child.on("error", (err) => error("Failed to start sandbox", err.message));
      });
    });

  // ── sandbox status ──
  cmd
    .command("status")
    .description("Show the current sandbox status for a space")
    .option("-s, --space <id>", "Target space ID")
    .option("--json", "Output as JSON")
    .action(async (opts: { space?: string; json?: boolean }) => {
      const spaceId = opts.space?.trim() || resolveSpace(program);
      const client = createClient();
      const result = await client.space(spaceId).sandbox.get().catch(() => null);
      const sandbox = result?.sandbox ?? null;
      if (jsonRequested(opts)) return outJson({ spaceId, sandbox });
      if (!sandbox) {
        console.log("  (no sandbox)");
        return;
      }
      console.log(`  space:    ${spaceId}`);
      console.log(`  provider: ${sandbox.provider ?? "cloud"}`);
      console.log(`  status:   ${sandbox.status ?? "unknown"}`);
    });
}
