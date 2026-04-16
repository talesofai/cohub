import { spawn } from "node:child_process";
import { access, cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { GLOBAL_CONFIG_REPO, env } from "./env.js";
import { reportSandboxStatus } from "./redis.js";

async function runGitCommand(args: string[], cwd?: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          stderr.trim() || `git ${args[0]} exited with non-zero status ${code}`,
        ),
      );
    });
  });
}

async function runGitClone(repositoryUrl: string, targetDir: string) {
  // --depth 1: shallow clone to reduce transfer size
  // -c checkout.workers=4: parallel checkout to amortize NFS metadata latency
  await runGitCommand([
    "-c",
    "checkout.workers=4",
    "clone",
    "--depth",
    "1",
    repositoryUrl,
    targetDir,
  ]);
}

async function copyConfigToHome(sourceDir: string, name: string) {
  const homeDir = process.env.HOME || "/root";
  const targetDir = join(homeDir, name);

  // If target already exists, skip to preserve user modifications
  try {
    await access(targetDir);
    console.log(`[Init] ${name} already exists at ${targetDir}, skipping.`);
    return;
  } catch {
    // directory does not exist, proceed with copy
  }

  await cp(sourceDir, targetDir, { recursive: true });
  console.log(`[Init] Copied ${name} to ${targetDir}`);
}

export async function initializeContainer() {
  console.log(
    `[Init] Starting container initialization for space: ${env.SPACE_ID}`,
  );
  await reportSandboxStatus("provisioning");

  try {
    await mkdir(env.WORKSPACE_DIR, { recursive: true });
    console.log(`[Init] Workspace directory ready: ${env.WORKSPACE_DIR}`);
  } catch (error) {
    console.error("[Init] Failed to create workspace directory:", error);
    throw error;
  }

  const tempDir = join("/tmp", `configs-${Date.now()}`);
  try {
    console.log(`[Init] Cloning config repo from ${GLOBAL_CONFIG_REPO}...`);
    await runGitClone(GLOBAL_CONFIG_REPO, tempDir);
    console.log("[Init] Config repo cloned successfully.");

    const entries = await readdir(tempDir);
    for (const entry of entries) {
      if (entry === ".git") continue;
      const entryPath = join(tempDir, entry);
      const stats = await stat(entryPath);
      if (stats.isDirectory()) {
        await copyConfigToHome(entryPath, entry);
      }
    }

    console.log("[Init] All configs applied to home directory.");
  } catch (error) {
    console.error("[Init] Failed to clone or apply configs:", error);
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  if (env.WORKSPACE_REPO_URL) {
    try {
      const files = await readdir(env.WORKSPACE_DIR);
      // Filter out K8s PVC system artifacts
      const userFiles = files.filter((f) => f !== "lost+found");

      if (userFiles.length === 0) {
        // Only system artifacts like lost+found — safe to clear and clone
        console.log("[Init] Workspace directory is empty (ignoring system files), cloning workspace repo...");
        for (const file of files) {
          await rm(join(env.WORKSPACE_DIR, file), { recursive: true, force: true });
        }
        await runGitCommand(["clone", env.WORKSPACE_REPO_URL, env.WORKSPACE_DIR]);

        if (env.WORKSPACE_GIT_USERNAME) {
          await runGitCommand(["config", "user.name", env.WORKSPACE_GIT_USERNAME], env.WORKSPACE_DIR);
        }
        if (env.WORKSPACE_GIT_EMAIL) {
          await runGitCommand(["config", "user.email", env.WORKSPACE_GIT_EMAIL], env.WORKSPACE_DIR);
        }

        console.log("[Init] Workspace repo cloned and configured successfully.");
      } else {
        console.log("[Init] Workspace directory has existing user files, skipping clone.");
      }
    } catch (error) {
      console.error("[Init] Failed to clone workspace repo:", error);
      throw error;
    }
  }

  console.log("[Init] Container initialization completed.");
}
