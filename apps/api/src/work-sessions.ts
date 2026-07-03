import { createWorkSessions } from "@cohub/core/auth";
import { config } from "./config.js";

const workSessions = createWorkSessions({ appEncryptionKey: config.appEncryptionKey });

export const createWorkSessionToken = workSessions.createWorkSessionToken;
export const verifyWorkSessionToken = workSessions.verifyWorkSessionToken;
export const hasWorkSessionPermission = workSessions.hasWorkSessionPermission;

export { WORK_SESSION_TTL_SECONDS, type WorkSessionPayload, type WorkSessionPrincipal } from "@cohub/core/auth";
