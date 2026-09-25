import { CommandContext, Context } from "grammy";
import { getActiveSessions, interruptSession } from "../../opencode/client-v2.js";
import { getCurrentSession } from "../../session/manager.js";
import { clearAllInteractionState } from "../../interaction/cleanup.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { foregroundSessionState } from "../../scheduled-task/foreground-state.js";
import { assistantRunState } from "../assistant-run-state.js";
import { markAttachedSessionIdle } from "../../attach/service.js";

type SessionState = "idle" | "busy" | "not-found";

interface AbortCurrentOperationOptions {
  notifyUser?: boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function abortLocalStreaming(): void {
  clearAllInteractionState("abort_command");
}

async function pollSessionStatus(
  sessionId: string,
  _directory: string,
  maxWaitMs: number = 5000,
): Promise<SessionState> {
  const startedAt = Date.now();
  const pollIntervalMs = 500;

  while (Date.now() - startedAt < maxWaitMs) {
    try {
      const { data, error } = await getActiveSessions();

      if (error || !data) {
        break;
      }

      const sessionStatus = data[sessionId];
      if (!sessionStatus) {
        return "idle";
      }

      if (sessionStatus.type === "running") {
        await sleep(pollIntervalMs);
        continue;
      }

      return "idle";
    } catch (error) {
      logger.warn("[Abort] Failed to poll session status:", error);
      break;
    }
  }

  return "busy";
}

export async function abortCurrentOperation(
  ctx: Context,
  options: AbortCurrentOperationOptions = {},
): Promise<void> {
  const notifyUser = options.notifyUser ?? true;

  try {
    abortLocalStreaming();

    const currentSession = getCurrentSession();

    if (!currentSession) {
      if (notifyUser) {
        await ctx.reply(t("stop.no_active_session"));
      }
      return;
    }

    let waitingMessageId: number | null = null;
    let chatId: number | null = null;

    if (notifyUser) {
      const waitingMessage = await ctx.reply(t("stop.in_progress"));
      waitingMessageId = waitingMessage.message_id;
      chatId = ctx.chat?.id ?? null;

      if (!chatId) {
        logger.warn("[Abort] Chat context is missing while aborting active session");
        return;
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const { data: abortResult, error: abortError } = await interruptSession(
        currentSession.id,
        false,
      );

      clearTimeout(timeoutId);

      if (abortError) {
        logger.warn("[Abort] Abort request failed:", abortError);
        if (notifyUser && chatId !== null && waitingMessageId !== null) {
          await ctx.api.editMessageText(chatId, waitingMessageId, t("stop.warn_unconfirmed"));
        }
        return;
      }

      if (!abortResult) {
        if (notifyUser && chatId !== null && waitingMessageId !== null) {
          await ctx.api.editMessageText(chatId, waitingMessageId, t("stop.warn_maybe_finished"));
        }
        return;
      }

      const finalStatus = await pollSessionStatus(
        currentSession.id,
        currentSession.directory,
        5000,
      );

      if (finalStatus === "idle" || finalStatus === "not-found") {
        foregroundSessionState.markIdle(currentSession.id);
        assistantRunState.clearRun(currentSession.id, "abort_confirmed");
        await markAttachedSessionIdle(currentSession.id);
        if (notifyUser && chatId !== null && waitingMessageId !== null) {
          await ctx.api.editMessageText(chatId, waitingMessageId, t("stop.success"));
        }
      } else {
        if (notifyUser && chatId !== null && waitingMessageId !== null) {
          await ctx.api.editMessageText(chatId, waitingMessageId, t("stop.warn_still_busy"));
        }
      }
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        if (notifyUser && chatId !== null && waitingMessageId !== null) {
          await ctx.api.editMessageText(chatId, waitingMessageId, t("stop.warn_timeout"));
        }
      } else {
        logger.error("[Abort] Error while aborting session:", error);
        if (notifyUser && chatId !== null && waitingMessageId !== null) {
          await ctx.api.editMessageText(chatId, waitingMessageId, t("stop.warn_local_only"));
        }
      }
    }
  } catch (error) {
    logger.error("[Abort] Unexpected error:", error);
    await ctx.reply(t("stop.error"));
  }
}

export async function abortCommand(ctx: CommandContext<Context>): Promise<void> {
  await abortCurrentOperation(ctx);
}
