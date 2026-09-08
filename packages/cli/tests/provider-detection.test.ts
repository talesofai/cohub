import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { detectLocalProviders } from "../src/commands/provider-detection.js";

const noCliAuth = async () => ({ code: 1, stdout: "" });

test("detects credentials from isolated provider files", async () => {
  const home = await mkdtemp(join(tmpdir(), "cohub-provider-detection-"));
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeFile(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "codex-test" } }));
  await writeFile(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "claude-test" } }));
  await writeFile(join(home, ".pi", "agent", "auth.json"), JSON.stringify({ deepseek: { type: "oauth", access: "pi-test", refresh: "pi-refresh", expires: 1 } }));

  const providers = await detectLocalProviders({
    env: { HOME: home },
    home,
    commandProbe: noCliAuth,
  });

  assert.deepEqual(providers.map((item) => item.provider), ["codex", "claude_code", "pi"]);
});

test("honors provider-specific credential directories", async () => {
  const home = await mkdtemp(join(tmpdir(), "cohub-provider-detection-"));
  const codexHome = join(home, "codex-home");
  const claudeHome = join(home, "claude-home");
  const piHome = join(home, "pi-home");
  await mkdir(claudeHome, { recursive: true });
  await mkdir(piHome, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, "auth.json"), JSON.stringify({ access_token: "codex-test" }));
  await writeFile(join(claudeHome, ".credentials.json"), JSON.stringify({ accessToken: "claude-test" }));
  await writeFile(join(piHome, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "pi-test" } }));

  const providers = await detectLocalProviders({
    env: {
      HOME: home,
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      PI_CODING_AGENT_DIR: piHome,
    },
    home,
    commandProbe: noCliAuth,
  });
  assert.deepEqual(providers.map((item) => item.provider), ["codex", "claude_code", "pi"]);
});

test("uses provider-specific Pi environment keys without treating shared keys as Pi auth", async () => {
  const home = await mkdtemp(join(tmpdir(), "cohub-provider-detection-"));
  const providers = await detectLocalProviders({
    env: { HOME: home, DEEPSEEK_API_KEY: "deepseek-test" },
    home,
    commandProbe: noCliAuth,
  });
  assert.deepEqual(providers.map((item) => item.provider), ["pi"]);

  const shared = await detectLocalProviders({
    env: { HOME: home, OPENAI_API_KEY: "openai-test" },
    home,
    commandProbe: noCliAuth,
  });
  assert.deepEqual(shared.map((item) => item.provider), ["codex"]);
});

test("does not treat ambient AWS credentials or false cloud flags as Claude auth", async () => {
  const home = await mkdtemp(join(tmpdir(), "cohub-provider-detection-"));
  const ambient = await detectLocalProviders({
    env: { HOME: home, AWS_PROFILE: "default" },
    home,
    commandProbe: noCliAuth,
  });
  assert.deepEqual(ambient, []);

  const disabled = await detectLocalProviders({
    env: { HOME: home, CLAUDE_CODE_USE_BEDROCK: "0", AWS_PROFILE: "default" },
    home,
    commandProbe: noCliAuth,
  });
  assert.deepEqual(disabled, []);

  const enabled = await detectLocalProviders({
    env: { HOME: home, CLAUDE_CODE_USE_BEDROCK: "true", AWS_PROFILE: "default" },
    home,
    commandProbe: noCliAuth,
  });
  assert.deepEqual(enabled.map((item) => item.provider), ["claude_code"]);
});

test("passes the caller environment to CLI probes", async () => {
  const home = await mkdtemp(join(tmpdir(), "cohub-provider-detection-"));
  const seen: NodeJS.ProcessEnv[] = [];
  const providers = await detectLocalProviders({
    env: { HOME: home, COHUB_PROBE_MARKER: "test-marker" },
    home,
    commandProbe: async (_command, _args, _timeout, env) => {
      if (env) seen.push(env);
      return { code: 1, stdout: "" };
    },
  });

  assert.deepEqual(providers, []);
  assert.equal(seen.length, 2);
  assert.equal(seen.every((env) => env.COHUB_PROBE_MARKER === "test-marker"), true);
});

test("accepts logged-in CLI status when no local auth file is present", async () => {
  const home = await mkdtemp(join(tmpdir(), "cohub-provider-detection-"));
  const calls: string[] = [];
  const providers = await detectLocalProviders({
    env: { HOME: home },
    home,
    commandProbe: async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "codex") return { code: 0, stdout: "Logged in with ChatGPT" };
      return { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "oauth" }) };
    },
  });

  assert.deepEqual(providers.map((item) => item.provider), ["codex", "claude_code"]);
  assert.deepEqual(calls, ["codex login status", "claude auth status --json"]);
});

test("does not treat a negative Codex status message as logged in", async () => {
  const home = await mkdtemp(join(tmpdir(), "cohub-provider-detection-"));
  const providers = await detectLocalProviders({
    env: { HOME: home },
    home,
    commandProbe: async (command) => command === "codex"
      ? { code: 0, stdout: "Not logged in" }
      : { code: 1, stdout: "" },
  });
  assert.deepEqual(providers, []);
});
