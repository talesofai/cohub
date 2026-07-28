export const LSP_AGENT_ACTIONS = [
  "status",
  "diagnostics",
  "definition",
  "references",
  "hover",
  "symbols",
] as const;

export const READ_ONLY_SANDBOX_TOOL_NAMES = [
  "read",
  "ls",
  "find",
  "grep",
  "lsp",
] as const;

export type LspAgentAction = (typeof LSP_AGENT_ACTIONS)[number];

export function isLspAgentAction(value: string): value is LspAgentAction {
  return (LSP_AGENT_ACTIONS as readonly string[]).includes(value);
}
