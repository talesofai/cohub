export const APP_ACTION_EXECUTION_SOURCE = "app_action" as const;

export type TaskType = string;

export interface TaskPayload {
  type: TaskType;
  spaceId?: string;
  sessionId?: string;
  turnId?: string;
  userId?: string;
  cronJobId?: string;
  data?: Record<string, unknown>;
}

export type TaskRunStatus = "pending" | "running" | "completed" | "failed";

export interface TaskScheduleConfig {
  pattern: string;
  timezone?: string;
}
