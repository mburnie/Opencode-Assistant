import type { Bot, Context } from "grammy";
import {
  getActiveSessions,
  getSessionForm,
  listPendingPermissions,
  listSessionForms,
  toLegacyPermissionRequest,
} from "../opencode/client-v2.js";
import { stopEventListening } from "../opencode/events.js";
import { summaryAggregator } from "../summary/aggregator.js";
import { pinnedMessageManager } from "../pinned/manager.js";
import { formManager } from "../form/manager.js";
import { permissionManager } from "../permission/manager.js";
import { handleFormCreated, showCurrentFormField } from "../bot/handlers/form.js";
import { showPermissionRequest } from "../bot/handlers/permission.js";
import type { SessionInfo } from "../session/manager.js";
import { getCurrentSession } from "../session/manager.js";
import { getCurrentProject } from "../settings/manager.js";
import { attachManager } from "./manager.js";
import { foregroundSessionState } from "../scheduled-task/foreground-state.js";
import { logger } from "../utils/logger.js";

interface EnsureAttachPinnedSessionParams {
  api: Context["api"];
  chatId: number;
  session: SessionInfo;
}

export interface AttachSessionDeps {
  bot: Bot<Context>;
  chatId: number;
  session: SessionInfo;
  ensureEventSubscription: (directory: string) => Promise<void>;
}

export interface AttachSessionResult {
  busy: boolean;
  alreadyAttached: boolean;
  restoredForm: boolean;
  restoredPermissions: number;
}

export interface RestoreAttachedCurrentSessionDeps {
  bot: Bot<Context>;
  chatId: number;
  ensureEventSubscription: (directory: string) => Promise<void>;
}

function getAttachBusyStatus(sessionId: string, statuses: unknown): boolean {
  if (!statuses || typeof statuses !== "object") {
    return false;
  }

  const sessionStatus = (statuses as Record<string, { type?: string }>)[sessionId];
  return sessionStatus?.type === "running";
}

async function ensureAttachPinnedSession({
  api,
  chatId,
  session,
}: EnsureAttachPinnedSessionParams): Promise<void> {
  if (!pinnedMessageManager.isInitialized()) {
    pinnedMessageManager.initialize(api, chatId);
  }

  const pinnedState = pinnedMessageManager.getState();
  if (pinnedState.sessionId === session.id && pinnedState.messageId) {
    return;
  }

  if (pinnedState.messageId && pinnedState.sessionId === null) {
    await pinnedMessageManager.restoreExistingSession(session.id, session.title);
  } else {
    await pinnedMessageManager.onSessionChange(session.id, session.title);
  }

  await pinnedMessageManager.loadContextFromHistory(session.id, session.directory);
}

async function syncPinnedAttachState(): Promise<void> {
  if (!pinnedMessageManager.isInitialized()) {
    return;
  }

  const attached = attachManager.getSnapshot();
  await pinnedMessageManager.setAttachState(attached !== null, attached?.busy ?? false);
}

async function restorePendingForm(
  bot: Bot<Context>,
  chatId: number,
  sessionId: string,
): Promise<boolean> {
  const { data: forms, error } = await listSessionForms(sessionId);

  if (error || !forms) {
    logger.warn("[Attach] Failed to load pending forms during attach:", error);
    return false;
  }

  for (const formInfo of forms) {
    const { data: form, error: formError } = await getSessionForm(sessionId, formInfo.id);

    if (formError || !form) {
      logger.warn(`[Attach] Failed to load form ${formInfo.id} during attach:`, formError);
      continue;
    }

    if (form.state.status !== "pending") {
      continue;
    }

    handleFormCreated(form, sessionId);
    await showCurrentFormField(bot.api, chatId);
    return true;
  }

  return false;
}

async function restorePendingPermissions(
  bot: Bot<Context>,
  chatId: number,
  sessionId: string,
  _directory: string,
): Promise<number> {
  const { data, error } = await listPendingPermissions(sessionId);

  if (error || !data) {
    logger.warn("[Attach] Failed to load pending permissions during attach:", error);
    return 0;
  }

  const pendingPermissions = data.filter((request) => request.sessionID === sessionId);
  for (const request of pendingPermissions) {
    await showPermissionRequest(bot.api, chatId, toLegacyPermissionRequest(request));
  }

  return pendingPermissions.length;
}

export async function attachToSession(deps: AttachSessionDeps): Promise<AttachSessionResult> {
  const { bot, chatId, session, ensureEventSubscription } = deps;
  const alreadyAttached = attachManager.isAttachedSession(session.id, session.directory);

  await ensureAttachPinnedSession({
    api: bot.api,
    chatId,
    session,
  });

  if (!alreadyAttached) {
    await ensureEventSubscription(session.directory);
    summaryAggregator.setSession(session.id);
    summaryAggregator.setBotAndChatId(bot, chatId);
    attachManager.attach(session.id, session.directory);
  } else {
    summaryAggregator.setSession(session.id);
    summaryAggregator.setBotAndChatId(bot, chatId);
  }

  const { data: statuses, error: statusesError } = await getActiveSessions();

  if (statusesError) {
    logger.warn("[Attach] Failed to load session status during attach:", statusesError);
  }

  const busy = getAttachBusyStatus(session.id, statuses);
  if (busy) {
    attachManager.markBusy(session.id);
  } else {
    attachManager.markIdle(session.id);
  }

  await syncPinnedAttachState();

  let restoredForm = false;
  let restoredPermissions = 0;

  if (!alreadyAttached && !formManager.isActive() && !permissionManager.isActive()) {
    restoredForm = await restorePendingForm(bot, chatId, session.id);

    if (!restoredForm) {
      restoredPermissions = await restorePendingPermissions(
        bot,
        chatId,
        session.id,
        session.directory,
      );
    }
  }

  return {
    busy,
    alreadyAttached,
    restoredForm,
    restoredPermissions,
  };
}

export async function restoreAttachedCurrentSession(
  deps: RestoreAttachedCurrentSessionDeps,
): Promise<boolean> {
  const currentProject = getCurrentProject();
  const currentSession = getCurrentSession();

  if (!currentProject || !currentSession) {
    return false;
  }

  if (currentSession.directory !== currentProject.worktree) {
    logger.warn(
      `[Attach] Skipping auto-restore because project/session mismatch: sessionDirectory=${currentSession.directory}, projectDirectory=${currentProject.worktree}`,
    );
    return false;
  }

  try {
    await attachToSession({
      bot: deps.bot,
      chatId: deps.chatId,
      session: currentSession,
      ensureEventSubscription: deps.ensureEventSubscription,
    });
    logger.info(
      `[Attach] Restored followed session on startup: session=${currentSession.id}, directory=${currentSession.directory}`,
    );
    return true;
  } catch (error) {
    logger.error("[Attach] Failed to restore followed session on startup:", error);
    return false;
  }
}

export function detachAttachedSession(reason: string): void {
  if (!attachManager.isAttached()) {
    return;
  }

  stopEventListening();
  summaryAggregator.clear();
  attachManager.clear(reason);
  void syncPinnedAttachState();
}

export async function markAttachedSessionBusy(sessionId: string): Promise<void> {
  if (!attachManager.markBusy(sessionId)) {
    return;
  }

  await syncPinnedAttachState();
}

export async function markAttachedSessionIdle(sessionId: string): Promise<void> {
  if (!attachManager.markIdle(sessionId)) {
    return;
  }

  await syncPinnedAttachState();
}

/**
 * Reconciles the local attached-session busy flag with OpenCode's
 * session.active() source of truth. Returns the reconciled busy state.
 *
 * This is used by the interaction guard and abort path to ensure a stale
 * local busy flag never permanently blocks Telegram input while OpenCode
 * reports the session as idle.
 */
export async function reconcileAttachedSessionBusyState(sessionId: string): Promise<boolean> {
  if (!attachManager.isAttachedSession(sessionId)) {
    return false;
  }

  const { data: statuses, error: statusesError } = await getActiveSessions();

  if (statusesError) {
    logger.warn("[Attach] Failed to load session status during reconcile:", statusesError);
    // On error, keep current local state to avoid falsely allowing input.
    return attachManager.isBusy();
  }

  const busy = getAttachBusyStatus(sessionId, statuses);
  if (busy) {
    attachManager.markBusy(sessionId);
  } else {
    attachManager.markIdle(sessionId);
  }

  return busy;
}

/**
 * Reconciles the local foreground-session busy flags with OpenCode's
 * session.active() source of truth. Mirrors reconcileAttachedSessionBusyState
 * for the foreground/scheduled-task run state, which is otherwise only
 * cleared by SSE idle events — if those are lost, input stays blocked
 * with a "session busy" message even though nothing is running.
 */
export async function reconcileForegroundSessionBusyState(): Promise<void> {
  if (!foregroundSessionState.isBusy()) {
    return;
  }

  const result = await getActiveSessions();

  if (!result) {
    logger.warn("[Attach] No session status during foreground reconcile");
    // On error, keep current local state to avoid falsely allowing input.
    return;
  }

  const { data: statuses, error: statusesError } = result;

  if (statusesError || !statuses) {
    logger.warn(
      "[Attach] Failed to load session status during foreground reconcile:",
      statusesError,
    );
    // On error, keep current local state to avoid falsely allowing input.
    return;
  }

  for (const sessionId of foregroundSessionState.getActiveSessionIds()) {
    const sessionStatus = (statuses as Record<string, { type?: string }>)[sessionId];
    if (sessionStatus?.type !== "running") {
      foregroundSessionState.markIdle(sessionId);
    }
  }
}
