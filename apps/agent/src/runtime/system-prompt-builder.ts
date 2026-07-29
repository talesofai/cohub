import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpaceModListItem } from "@cohub/core/space-mods";
import {
  loadSkillsFromDirectory,
  mergeSkillsConfigs,
  type Skill,
  type SkillScope,
} from "@cohub/infra/config-runtime/skills";
import {
  getAgentPlatformAgentPath,
  getAgentPlatformSkillsPath,
  getAgentUserAgentsPath,
  getAgentUserConfigPath,
  getAgentUserSkillsPath,
  getAgentWorkspaceAgentsPath,
  getAgentWorkspacePath,
  getAgentWorkspaceSkillsPath,
  SANDBOX_PLATFORM_SKILLS_PATH,
  SANDBOX_USER_CONFIG_PATH,
  SANDBOX_USER_SKILLS_PATH,
  SANDBOX_WORKSPACE_PATH,
  SANDBOX_WORKSPACE_SKILLS_PATH,
} from "./paths.js";

const FALLBACK_SYSTEM_PROMPT = "You are a helpful assistant.";

type LoadedContextFile = {
  sandboxPath: string;
  content: string;
};

export type BuildCohubSystemPromptOptions = {
  cwd: string;
  userId?: string | null;
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
  spaceMods?: SpaceModListItem[];
  appendInstructions?: string | null;
  includeUserSkills?: boolean;
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    const content = (await readFile(path, "utf-8")).trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

async function loadFirstExisting(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    const content = await readTextIfExists(path);
    if (content) return content;
  }
  return undefined;
}

async function loadContextFilesFromRoot(root: string, sandboxRoot: string): Promise<LoadedContextFile[]> {
  const files: LoadedContextFile[] = [];
  const agentsContent = await readTextIfExists(join(root, "AGENTS.md"));
  if (agentsContent) {
    files.push({
      sandboxPath: `${sandboxRoot}/AGENTS.md`,
      content: agentsContent,
    });
  }

  const claudeContent = await readTextIfExists(join(root, "CLAUDE.md"));
  if (claudeContent) {
    files.push({
      sandboxPath: `${sandboxRoot}/CLAUDE.md`,
      content: claudeContent,
    });
  }

  return files;
}

async function loadSkillsFromDir(input: {
  agentDir: string;
  sandboxDir: string;
  scope: SkillScope;
}): Promise<Skill[]> {
  if (!(await pathExists(input.agentDir))) return [];
  const { content } = await loadSkillsFromDirectory({
    dir: input.agentDir,
    sandboxDir: input.sandboxDir,
    scope: input.scope,
  });
  return content.skills;
}

async function loadMergedSkills(cwd: string, userId?: string | null, spaceMods: SpaceModListItem[] = [], options: { includeUserSkills?: boolean } = {}): Promise<Skill[]> {
  const modSkillGroups = await Promise.all(spaceMods.map((mod) => loadSkillsFromDir({
    agentDir: join(getAgentWorkspacePath(mod.modSpaceId), ".agents", "skills"),
    sandboxDir: `${mod.mountPath}/.agents/skills`,
    scope: "mod",
  })));

  const [platformSkills, userSkills, workspaceSkills] = await Promise.all([
    loadSkillsFromDir({
      agentDir: getAgentPlatformSkillsPath(),
      sandboxDir: SANDBOX_PLATFORM_SKILLS_PATH,
      scope: "platform",
    }),
    userId && options.includeUserSkills !== false
      ? loadSkillsFromDir({
          agentDir: getAgentUserSkillsPath(userId),
          sandboxDir: SANDBOX_USER_SKILLS_PATH,
          scope: "user",
        })
      : Promise.resolve([]),
    loadSkillsFromDir({
      agentDir: getAgentWorkspaceSkillsPath(cwd),
      sandboxDir: SANDBOX_WORKSPACE_SKILLS_PATH,
      scope: "project",
    }),
  ]);

  // Priority (later overrides earlier): platform < mods < user < workspace
  return mergeSkillsConfigs(
    { skills: platformSkills },
    ...modSkillGroups.map((skills) => ({ skills })),
    { skills: userSkills },
    { skills: workspaceSkills },
  ).skills;
}

function formatSkillsForPrompt(skills: Skill[]): string {
  // Skills with disableModelInvocation are hidden from the model; they remain
  // invocable explicitly via `/skill:name`.
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";

  let out = "The following skills provide specialized instructions for specific tasks.\n";
  out += "Use the read tool to load a skill's file when the task matches its description.\n";
  out += "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n";
  out += "<available_skills>\n";
  for (const skill of visible) {
    out += "  <skill>\n";
    out += `    <name>${skill.name}</name>\n`;
    out += `    <description>${skill.description}</description>\n`;
    out += `    <location>${skill.sandboxFilePath}</location>\n`;
    out += "  </skill>\n";
  }
  out += "</available_skills>";
  return out;
}

export async function buildCohubSystemPrompt(options: BuildCohubSystemPromptOptions): Promise<string> {
  const {
    cwd,
    userId,
    selectedTools = ["read", "bash", "edit", "write"],
    toolSnippets = {},
    promptGuidelines = [],
    spaceMods = [],
    includeUserSkills = true,
  } = options;

  const workspaceAgentDir = getAgentWorkspaceAgentsPath(cwd);
  const userAgentDir = userId ? getAgentUserAgentsPath(userId) : null;
  const systemPrompt = await loadFirstExisting([
    join(workspaceAgentDir, "SYSTEM.md"),
    ...(userAgentDir ? [join(userAgentDir, "SYSTEM.md")] : []),
    join(getAgentPlatformAgentPath(), "SYSTEM.md"),
  ]) ?? FALLBACK_SYSTEM_PROMPT;

  const appendSystemPrompts = (await Promise.all([
    readTextIfExists(join(getAgentPlatformAgentPath(), "APPEND_SYSTEM.md")),
    ...spaceMods.map((mod) => readTextIfExists(join(getAgentWorkspacePath(mod.modSpaceId), ".cohub", "APPEND_SYSTEM.md"))),
    ...(userAgentDir ? [readTextIfExists(join(userAgentDir, "APPEND_SYSTEM.md"))] : []),
    readTextIfExists(join(workspaceAgentDir, "APPEND_SYSTEM.md")),
  ])).filter((value): value is string => Boolean(value));

  const [userContextFiles, modContextGroups, projectContextFiles, skills] = await Promise.all([
    userId ? loadContextFilesFromRoot(getAgentUserConfigPath(userId), SANDBOX_USER_CONFIG_PATH) : Promise.resolve([]),
    Promise.all(spaceMods.map((mod) => loadContextFilesFromRoot(getAgentWorkspacePath(mod.modSpaceId), mod.mountPath))),
    loadContextFilesFromRoot(cwd, SANDBOX_WORKSPACE_PATH),
    selectedTools.includes("read") ? loadMergedSkills(cwd, userId, spaceMods, { includeUserSkills }) : Promise.resolve([]),
  ]);

  const sections: string[] = [systemPrompt, ...appendSystemPrompts];

  if (userContextFiles.length > 0) {
    let userContext = "# User Context\n\nThe following are user-specific preferences and instructions. Follow them when they do not conflict with platform, safety, or project-specific instructions:";
    for (const file of userContextFiles) {
      userContext += `\n\n${file.content}`;
    }
    sections.push(userContext);
  }

  const modContextFiles = modContextGroups.flat();
  if (spaceMods.length > 0 || modContextFiles.length > 0) {
    let modContext = '# Mods\n\nMods are additional read-only resources mounted under /mods. Each list item is "name: path". Instruction priority: platform < mods < user < workspace.';
    for (const mod of spaceMods) {
      modContext += `\n- ${mod.modSpaceName ?? mod.modSpaceId}: ${mod.mountPath}`;
    }
    for (const file of modContextFiles) {
      modContext += `\n\n## ${file.sandboxPath}\n\n${file.content}`;
    }
    sections.push(modContext);
  }

  if (projectContextFiles.length > 0) {
    let projectContext = "# Project Context\n\nProject-specific instructions and guidelines:";
    for (const file of projectContextFiles) {
      projectContext += `\n\n## ${file.sandboxPath}\n\n${file.content}`;
    }
    sections.push(projectContext);
  }

  if (skills.length > 0) {
    sections.push(formatSkillsForPrompt(skills));
  }

  const appendInstructions = options.appendInstructions?.trim();
  if (appendInstructions) {
    sections.push([
      "# Request Instructions",
      "",
      "Apply these instructions only to the current turn. They do not override platform safety or access controls.",
      "",
      appendInstructions,
    ].join("\n"));
  }

  const visibleTools = selectedTools.filter((name) => toolSnippets[name]);
  const toolsList = visibleTools.length > 0
    ? visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n")
    : "";

  const guidelines = new Set<string>();
  if (selectedTools.includes("bash") && (selectedTools.includes("grep") || selectedTools.includes("find") || selectedTools.includes("ls"))) {
    guidelines.add("Prefer grep/find/ls tools over bash for file exploration when available");
  }
  for (const item of promptGuidelines) {
    const value = item.trim();
    if (value) guidelines.add(value);
  }

  if (systemPrompt === FALLBACK_SYSTEM_PROMPT) {
    if (toolsList) {
      sections.push(`Available tools:\n${toolsList}`);
    }
    if (guidelines.size > 0) {
      sections.push(`Guidelines:\n${Array.from(guidelines).map((line) => `- ${line}`).join("\n")}`);
    }
  }

  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  sections.push(`Current date: ${date}`);
  sections.push(`Current working directory: ${SANDBOX_WORKSPACE_PATH}`);

  return sections.filter((section) => section.trim().length > 0).join("\n\n");
}
