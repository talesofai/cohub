import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { UnrecoverableError, type Job } from "bullmq";
import { recordJobFailure } from "@cohub/infra/bullmq";
import { getAgentTracer, wrapToolCall } from "@cohub/infra/tracing/agent";
import { createSandboxCodingTools } from "./sandbox/tools.js";
import { runWithToolExecutionContext } from "./tool-context.js";
import { logger } from "./logger.js";
import type { AgentSandboxBashUploadJobData } from "./queue.js";
import { loadSpaceEnvSnapshot } from "./runtime/env-cache.js";
import { withAgentWorkspaceLease } from "./workspace-lease.js";
import { acquireWorkspacePhysicalLock } from "./workspace-physical-lock.js";

const SCRIPT_PATH = new URL("./jobs/sandbox-bash/upload-files.sh", import.meta.url);
const tools = createSandboxCodingTools();
const tracer = getAgentTracer();

async function loadScript() {
  return readFile(SCRIPT_PATH, "utf8");
}

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function toBase64(value: string) {
  return Buffer.from(value, "utf8").toString("base64");
}

function buildManifest(data: AgentSandboxBashUploadJobData) {
  return data.files
    .map((file) => [toBase64(file.relativePath), String(file.size), toBase64(file.downloadUrl)].join("\t"))
    .join("\n");
}

async function buildUploadCommand(data: AgentSandboxBashUploadJobData) {
  const script = await loadScript();
  const manifest = buildManifest(data);
  return [
    "set -euo pipefail",
    "script_path=$(mktemp /tmp/cohub-upload-files.XXXXXX.sh)",
    "trap 'rm -f \"$script_path\"' EXIT",
    "cat > \"$script_path\" <<'COHUB_UPLOAD_SCRIPT'",
    script.trimEnd(),
    "COHUB_UPLOAD_SCRIPT",
    "chmod +x \"$script_path\"",
    `UPLOAD_ROOT=${shellSingleQuote(data.destinationRoot)} bash "$script_path" <<'COHUB_UPLOAD_MANIFEST'`,
    manifest,
    "COHUB_UPLOAD_MANIFEST",
  ].join("\n");
}

function extractResultText(result: unknown) {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "text"
      ? String((item as { text?: unknown }).text ?? "")
      : "")
    .join("");
}

function getExitCode(result: unknown) {
  if (!result || typeof result !== "object") return null;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return null;
  const exitCode = (details as { exitCode?: unknown }).exitCode;
  return typeof exitCode === "number" ? exitCode : null;
}

function parseUploadedLines(output: string, data: AgentSandboxBashUploadJobData) {
  const expected = new Map(data.files.map((file) => [file.relativePath, file]));
  const uploaded = new Map<string, { path: string; name: string; size: number; mimeType: string | null; mtimeMs: number }>();

  for (const line of output.split(/\r?\n/)) {
    const [kind, relativePath, targetPath] = line.split("\t");
    if (kind !== "uploaded" || !relativePath || !targetPath) continue;
    const file = expected.get(relativePath);
    if (!file) continue;
    uploaded.set(relativePath, {
      path: targetPath,
      name: file.name,
      size: file.size,
      mimeType: file.mimeType,
      mtimeMs: Date.now(),
    });
  }

  if (uploaded.size !== data.files.length) {
    throw new Error(`Uploaded file count mismatch: expected ${data.files.length}, got ${uploaded.size}`);
  }

  return [...uploaded.values()];
}

export async function processSandboxBashJob(job: Job<AgentSandboxBashUploadJobData>) {
  const data = job.data;
  if (!data.spaceId || !data.sessionId || !data.uploadId || !data.destinationRoot || !Array.isArray(data.files)) {
    throw new Error("Invalid sandbox_bash upload job payload");
  }

  const bashTool = tools.find((tool) => tool.name === "bash");
  if (!bashTool) throw new Error("bash tool is not available");

  const command = await buildUploadCommand(data);
  const toolCallId = `sandbox_bash_${randomUUID()}`;
  const totalBytes = data.files.reduce((sum, file) => sum + file.size, 0);
  const logMeta = {
    jobId: job.id,
    spaceId: data.spaceId,
    sessionId: data.sessionId,
    uploadId: data.uploadId,
    destinationRoot: data.destinationRoot,
    fileCount: data.files.length,
    totalBytes,
    firstFile: data.files[0]?.relativePath,
    requestId: data.requestId ?? undefined,
  };
  let latestOutput = "";

  await job.updateProgress({
    stage: "running",
    ...logMeta,
  });

  const spaceEnv = await loadSpaceEnvSnapshot(data.spaceId);
  const workspacePhysicalLock = data.workspaceLease ? await acquireWorkspacePhysicalLock(data.spaceId) : null;
  if (data.workspaceLease && !workspacePhysicalLock) throw new Error("workspace_physical_writer_active");
  try {
    await runWithToolExecutionContext({
    spaceId: data.spaceId,
    sessionId: data.sessionId,
    spaceEnv,
    llmRound: 0,
    toolCallId,
    requestId: data.requestId ?? undefined,
  }, async () => wrapToolCall(tracer, {
    toolName: "sandbox_bash",
    input: { task: "upload_files", uploadId: data.uploadId, files: data.files.length },
    spaceId: data.spaceId,
    sessionId: data.sessionId,
    llmRound: 0,
    toolCallId,
    requestId: data.requestId ?? undefined,
  }, async () => {
    const result = await withAgentWorkspaceLease({
      spaceId: data.spaceId,
      lease: data.workspaceLease ?? null,
      run: (leaseSignal) => bashTool.execute(
        toolCallId,
        { command, timeout: 3600 } as never,
        leaseSignal,
        (partial) => {
          const text = extractResultText(partial);
          if (text) latestOutput = text;
        },
      ),
    });
    latestOutput = extractResultText(result) || latestOutput;
    const exitCode = getExitCode(result);
    if (exitCode !== 0) {
      const error = new Error(latestOutput || `sandbox_bash upload_files failed with exit code ${exitCode ?? "unknown"}`);
      const failure = await recordJobFailure(job, error, {
        reason: "sandbox_bash_command_failed",
        meta: {
          ...logMeta,
          exitCode,
          outputTail: latestOutput.slice(-2000),
        },
      });
      logger.error("[SandboxBash] upload command failed", failure);
      if (exitCode === 3) throw new UnrecoverableError(`upload_size_mismatch: ${error.message}`);
      if (exitCode === 2 || exitCode === 127) throw new UnrecoverableError(error.message);
      throw error;
      }
    }));
  } finally {
    await workspacePhysicalLock?.release().catch((error) => {
      logger.error("[WorkspaceLock] failed to release sandbox upload lock", { spaceId: data.spaceId, error });
    });
  }

  try {
    const uploaded = parseUploadedLines(latestOutput, data);
    await job.updateProgress({
      stage: "completed",
      ...logMeta,
      uploadedCount: uploaded.length,
      firstUploadedPath: uploaded[0]?.path,
    });
    return { ok: true, uploaded, output: latestOutput };
  } catch (error) {
    const failure = await recordJobFailure(job, error, {
      reason: "sandbox_bash_result_parse_failed",
      meta: {
        ...logMeta,
        outputTail: latestOutput.slice(-2000),
      },
    });
    logger.error("[SandboxBash] upload result parse failed", error, failure);
    throw error;
  }
}
