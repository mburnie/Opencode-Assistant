import { Bot, Context } from "grammy";
import {
  createSession,
  getActiveSessions,
  promptSession,
  type LegacyFilePart,
  type LegacyTextPart,
} from "../../opencode/client-v2.js";
import { clearSession, getCurrentSession, setCurrentSession } from "../../session/manager.js";
import { ingestSessionInfoForCache } from "../../session/cache-manager.js";
import { getCurrentProject, isTtsEnabled } from "../../settings/manager.js";
import { getStoredAgent, resolveProjectAgent } from "../../agent/manager.js";
import { pinnedMessageManager } from "../../pinned/manager.js";
import { getStoredModel, isFreeModel } from "../../model/manager.js";
import { summaryAggregator } from "../../summary/aggregator.js";
import { stopEventListening } from "../../opencode/events.js";
import { interactionManager } from "../../interaction/manager.js";
import { clearAllInteractionState } from "../../interaction/cleanup.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { formatErrorDetails } from "../../utils/error-format.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { foregroundSessionState } from "../../scheduled-task/foreground-state.js";
import { assistantRunState } from "../assistant-run-state.js";
import {
  attachToSession,
  detachAttachedSession,
  markAttachedSessionBusy,
  markAttachedSessionIdle,
} from "../../attach/service.js";
import { externalUserInputSuppressionManager } from "../../external-input/suppression.js";
import { injectMemoryIntoPrompt } from "../../memory/injector.js";

/** Module-level references for async callbacks that don't have ctx. */
let botInstance: Bot<Context> | null = null;
let chatIdInstance: number | null = null;
const promptResponseModes = new Map<string, PromptResponseMode>();

export type PromptResponseMode = "text_only" | "text_and_tts";

/**
 * Injected into the prompt when the selected model is free (zero cost).
 * Free models may work normally inside the current task and the active
 * project without approval. Approval is only required when crossing into
 * anything outside the active project or task scope (unrelated files or
 * directories, secrets, personal memory, health information, accounts,
 * system configuration, services, external side effects, or destructive
 * actions), and a previous approval never extends to other actions.
 */
const FREE_MODEL_SCOPE_INSTRUCTION =
  "SECURITY CONSTRAINT (free-plan session): " +
  "You may work normally inside the current task and the active project without asking. " +
  "Before crossing into anything OUTSIDE the active project or task scope — unrelated files " +
  "or directories, secrets or credentials, personal memory, health information, accounts, " +
  "private user data, system configuration, services, external side effects, or destructive " +
  "actions — state your exact intended action and target, then wait for explicit user approval. " +
  "An approval covers only the one action it was given for; never reuse or extend it.";

type ProcessPromptOptions = {
  responseMode?: PromptResponseMode;
};

export function getPromptBotInstance(): Bot<Context> | null {
  return botInstance;
}

export function getPromptChatId(): number | null {
  return chatIdInstance;
}

export function setPromptResponseMode(sessionId: string, responseMode: PromptResponseMode): void {
  promptResponseModes.set(sessionId, responseMode);
}

export function clearPromptResponseMode(sessionId: string): void {
  promptResponseModes.delete(sessionId);
}

export function consumePromptResponseMode(sessionId: string): PromptResponseMode | null {
  const responseMode = promptResponseModes.get(sessionId) ?? null;
  promptResponseModes.delete(sessionId);
  return responseMode;
}

async function isSessionBusy(sessionId: string, _directory: string): Promise<boolean> {
  try {
    const { data, error } = await getActiveSessions();

    if (error || !data) {
      logger.warn("[Bot] Failed to check session status before prompt:", error);
      return false;
    }

    const sessionStatus = data[sessionId];
    if (!sessionStatus) {
      return false;
    }

    logger.debug(`[Bot] Current session status before prompt: ${sessionStatus.type || "unknown"}`);
    return sessionStatus.type === "running";
  } catch (err) {
    logger.warn("[Bot] Error checking session status before prompt:", err);
    return false;
  }
}

async function resetMismatchedSessionContext(): Promise<void> {
  detachAttachedSession("session_mismatch_reset");
  stopEventListening();
  summaryAggregator.clear();
  foregroundSessionState.clearAll("session_mismatch_reset");
  assistantRunState.clearAll("session_mismatch_reset");
  clearAllInteractionState("session_mismatch_reset");
  clearSession();

  if (!pinnedMessageManager.isInitialized()) {
    return;
  }

  try {
    await pinnedMessageManager.clear();
  } catch (err) {
    logger.error("[Bot] Failed to clear pinned message during session reset:", err);
  }
}

export interface ProcessPromptDeps {
  bot: Bot<Context>;
  ensureEventSubscription: (directory: string) => Promise<void>;
}

/**
 * Processes a user prompt: ensures project/session, subscribes to events, and sends
 * the prompt to OpenCode. Used by text, voice, and photo message handlers.
 *
 * @param ctx - Grammy context
 * @param text - Text content of the prompt
 * @param deps - Dependencies (bot and event subscription)
 * @param fileParts - Optional file parts (for photo/document attachments)
 * @returns true if the prompt was dispatched, false if it was blocked/failed early.
 */
export async function processUserPrompt(
  ctx: Context,
  text: string,
  deps: ProcessPromptDeps,
  fileParts: LegacyFilePart[] = [],
  options: ProcessPromptOptions = {},
): Promise<boolean> {
  const { bot, ensureEventSubscription } = deps;
  const responseMode = options.responseMode ?? (isTtsEnabled() ? "text_and_tts" : "text_only");

  const currentProject = getCurrentProject();
  if (!currentProject) {
    await ctx.reply(t("bot.project_not_selected"));
    return false;
  }

  botInstance = bot;
  chatIdInstance = ctx.chat!.id;

  let currentSession = getCurrentSession();
  let createdNewSession = false;

  if (currentSession && currentSession.directory !== currentProject.worktree) {
    logger.warn(
      `[Bot] Session/project mismatch detected. sessionDirectory=${currentSession.directory}, projectDirectory=${currentProject.worktree}. Resetting session context.`,
    );
    await resetMismatchedSessionContext();
    await ctx.reply(t("bot.session_reset_project_mismatch"));
    return false;
  }

  if (!currentSession) {
    await ctx.reply(t("bot.creating_session"));

    const { data: session, error } = await createSession({
      directory: currentProject.worktree,
    });

    if (error || !session) {
      await ctx.reply(t("bot.create_session_error"));
      return false;
    }

    logger.info(
      `[Bot] Created new session: id=${session.id}, title="${session.title}", project=${currentProject.worktree}`,
    );

    currentSession = {
      id: session.id,
      title: session.title ?? "Untitled",
      directory: currentProject.worktree,
    };

    setCurrentSession("telegram", currentSession);
    await ingestSessionInfoForCache(session);
    createdNewSession = true;
  } else {
    logger.info(
      `[Bot] Using existing session: id=${currentSession.id}, title="${currentSession.title}"`,
    );
  }

  if (!currentSession) {
    return false;
  }

  await attachToSession({
    bot,
    chatId: ctx.chat!.id,
    session: currentSession,
    ensureEventSubscription,
  });

  if (createdNewSession) {
    await ctx.reply(t("bot.session_created", { title: currentSession.title }));
  }

  const sessionIsBusy = await isSessionBusy(currentSession.id, currentSession.directory);
  if (sessionIsBusy) {
    logger.info(`[Bot] Ignoring new prompt: session ${currentSession.id} is busy`);
    await ctx.reply(t("bot.session_busy"));
    return false;
  }

  try {
    const currentAgent = await resolveProjectAgent(getStoredAgent());
    const storedModel = getStoredModel();

    // Build prompt text and file list for the new SDK shape.
    let promptText = "";
    if (text.trim().length > 0) {
      promptText = await injectMemoryIntoPrompt(text, currentSession.id, {
        channel: "telegram",
      });
    }

    const promptFiles: LegacyFilePart[] = fileParts.filter(
      (part): part is LegacyFilePart => part.type === "file",
    );

    // If only files are provided, add a minimal text prompt.
    if (promptText.length === 0 && promptFiles.length > 0) {
      promptText = "See attached file";
    }

    // Free models get no implicit access beyond the current task: append the
    // approval-scope constraint so out-of-scope accesses must be explicitly
    // approved (tool-level permission rules back this up for write/shell/etc.).
    const currentModelIsFree =
      storedModel.providerID && storedModel.modelID
        ? await isFreeModel(storedModel.providerID, storedModel.modelID)
        : false;
    if (currentModelIsFree) {
      logger.info(
        `[Bot] Free model detected (${storedModel.providerID}/${storedModel.modelID}); ` +
          "appending approval-scope instruction",
      );
      promptText = `${promptText}\n\n${FREE_MODEL_SCOPE_INSTRUCTION}`.trim();
    }

    const promptModel =
      storedModel.providerID && storedModel.modelID
        ? {
            providerID: storedModel.providerID,
            modelID: storedModel.modelID,
            variant: storedModel.variant,
          }
        : undefined;

    const promptErrorLogContext = {
      sessionId: currentSession.id,
      directory: currentSession.directory,
      agent: currentAgent || "default",
      modelProvider: storedModel.providerID || "default",
      modelId: storedModel.modelID || "default",
      variant: storedModel.variant || "default",
      promptLength: text.length,
      fileCount: fileParts.length,
    };

    logger.info(
      `[Bot] Calling session.prompt with agent=${currentAgent}, fileCount=${fileParts.length}...`,
    );

    foregroundSessionState.markBusy(currentSession.id);
    await markAttachedSessionBusy(currentSession.id);
    assistantRunState.startRun(currentSession.id, {
      startedAt: Date.now(),
      configuredAgent: currentAgent,
      configuredProviderID: storedModel.providerID,
      configuredModelID: storedModel.modelID,
    });
    setPromptResponseMode(currentSession.id, responseMode);

    if (text.trim().length > 0) {
      externalUserInputSuppressionManager.register(currentSession.id, text);
    }

    // CRITICAL: Use the async prompt start endpoint here.
    // session.prompt streams the full assistant response and can outlive the original
    // Telegram message handler, which turns late transport failures into misleading
    // "failed to send" messages even after the run has already started.
    // The actual assistant result still arrives via the SSE event subscription.
    safeBackgroundTask({
      taskName: "session.prompt",
      task: () =>
        promptSession({
          sessionID: currentSession.id,
          text: promptText,
          files: promptFiles,
          agent: currentAgent,
          model: promptModel,
        }),
      onSuccess: ({ error }) => {
        if (error) {
          foregroundSessionState.markIdle(currentSession.id);
          void markAttachedSessionIdle(currentSession.id);
          assistantRunState.clearRun(currentSession.id, "session_prompt_api_error");
          clearPromptResponseMode(currentSession.id);
          const details = formatErrorDetails(error, 6000);
          logger.error(
            "[Bot] OpenCode API returned an error for session.prompt",
            promptErrorLogContext,
          );
          logger.error("[Bot] session.prompt error details:", details);
          logger.error("[Bot] session.prompt raw API error object:", error);

          // Send user-friendly error via API directly because ctx is no longer available
          void bot.api.sendMessage(ctx.chat!.id, t("bot.prompt_send_error")).catch(() => {});
          return;
        }

        logger.info("[Bot] session.prompt accepted");
      },
      onError: (error) => {
        foregroundSessionState.markIdle(currentSession.id);
        void markAttachedSessionIdle(currentSession.id);
        assistantRunState.clearRun(currentSession.id, "session_prompt_background_error");
        clearPromptResponseMode(currentSession.id);
        const details = formatErrorDetails(error, 6000);
        logger.error("[Bot] session.prompt background task failed", promptErrorLogContext);
        logger.error("[Bot] session.prompt background failure details:", details);
        logger.error("[Bot] session.prompt raw background error object:", error);
        void bot.api.sendMessage(ctx.chat!.id, t("bot.prompt_send_error")).catch(() => {});
      },
    });

    return true;
  } catch (err) {
    if (currentSession) {
      foregroundSessionState.markIdle(currentSession.id);
      await markAttachedSessionIdle(currentSession.id);
      assistantRunState.clearRun(currentSession.id, "session_prompt_handler_error");
    }
    logger.error("Error in prompt handler:", err);
    if (interactionManager.getSnapshot()) {
      clearAllInteractionState("message_handler_error");
    }
    await ctx.reply(t("error.generic"));
    return false;
  }
}
