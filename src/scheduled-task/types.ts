import type { ModelInfo } from "../model/types.js";

export type ScheduledTaskKind = "cron" | "once";

export type ScheduledTaskStatus = "idle" | "running" | "success" | "error";

export type ScheduledTaskType = "task" | "reminder" | "backup";

export interface ScheduledTaskModel {
  providerID: string;
  modelID: string;
  variant: string | null;
}

export interface ScheduledTaskBase {
  id: string;
  type: ScheduledTaskType;
  projectId: string;
  projectWorktree: string;
  /**
   * Optional per-task model override. When null/absent the task follows the
   * model of the OpenCode session it executes against (Leroy has no model of
   * its own). The explicit `/model` selection is NOT stored here — only a
   * caller-provided override is.
   */
  model: ScheduledTaskModel | null;
  scheduleText: string;
  scheduleSummary: string;
  timezone: string;
  prompt: string;
  createdAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  runCount: number;
  lastStatus: ScheduledTaskStatus;
  lastError: string | null;
}

export interface ScheduledCronTask extends ScheduledTaskBase {
  kind: "cron";
  cron: string;
  runAt?: undefined;
}

export interface ScheduledOnceTask extends ScheduledTaskBase {
  kind: "once";
  cron?: undefined;
  runAt: string;
}

export type ScheduledTask = ScheduledCronTask | ScheduledOnceTask;

export interface ParsedCronSchedule {
  kind: "cron";
  cron: string;
  timezone: string;
  summary: string;
  nextRunAt: string;
}

export interface ParsedOnceSchedule {
  kind: "once";
  runAt: string;
  timezone: string;
  summary: string;
  nextRunAt: string;
}

export type ParsedTaskSchedule = ParsedCronSchedule | ParsedOnceSchedule;

export interface TaskCreationState {
  stage: "awaiting_schedule" | "parsing_schedule" | "awaiting_prompt";
  projectId: string;
  projectWorktree: string;
  model: ScheduledTaskModel | null;
  scheduleText: string | null;
  parsedSchedule: ParsedTaskSchedule | null;
  scheduleRequestMessageId: number | null;
  previewMessageId: number | null;
  promptRequestMessageId: number | null;
}

export function createScheduledTaskModel(model: ModelInfo): ScheduledTaskModel {
  return {
    providerID: model.providerID,
    modelID: model.modelID,
    variant: model.variant ?? null,
  };
}

export function cloneParsedTaskSchedule(schedule: ParsedTaskSchedule): ParsedTaskSchedule {
  return { ...schedule };
}

export function cloneScheduledTaskModel(model: ScheduledTaskModel | null): ScheduledTaskModel | null {
  return model ? { ...model } : null;
}

export function cloneScheduledTask(task: ScheduledTask): ScheduledTask {
  return {
    ...task,
    type: task.type ?? "task",
    model: cloneScheduledTaskModel(task.model),
  };
}

export interface ScheduledTaskExecutionResult {
  taskId: string;
  status: "success" | "error";
  startedAt: string;
  finishedAt: string;
  resultText: string | null;
  errorMessage: string | null;
}

export interface QueuedScheduledTaskDelivery {
  taskId: string;
  scheduleSummary: string;
  prompt: string;
  runAt: string;
  status: "success" | "error";
  notificationText: string;
  resultText?: string;
  deliveryId?: string;
}

export interface PendingCronDelivery {
  deliveryId: string;
  taskId: string;
  prompt: string;
  resultText: string;
  runAt: string;
  createdAt: number;
}
