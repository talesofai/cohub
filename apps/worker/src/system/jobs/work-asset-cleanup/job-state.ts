const TERMINAL_PUBLISH_JOB_STATES = new Set(["completed", "failed"]);

export function isWorkAssetPublishJobTerminal(state: string) {
  return TERMINAL_PUBLISH_JOB_STATES.has(state);
}
