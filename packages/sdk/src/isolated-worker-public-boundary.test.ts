import type { CreateSpacePromptInput, SendMessageCronJobPayload } from "./types.js";

const content = [{ type: "text" as const, text: "work" }];

const publicPrompt: CreateSpacePromptInput = { content, accessMode: "full_access" };
const scheduledPrompt: SendMessageCronJobPayload = { content, accessMode: "read_only" };
void publicPrompt;
void scheduledPrompt;

// isolated_worker is available only through the dedicated disposable-worker API.
// @ts-expect-error generic public prompt must not expose isolated_worker
const forbiddenPublicPrompt: CreateSpacePromptInput = { content, accessMode: "isolated_worker" };
// @ts-expect-error scheduled generic prompt must not expose isolated_worker
const forbiddenScheduledPrompt: SendMessageCronJobPayload = { content, accessMode: "isolated_worker" };
void forbiddenPublicPrompt;
void forbiddenScheduledPrompt;
