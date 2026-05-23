import type { Bot } from "grammy";
import { CommandContext, Context } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { setCurrentSession, SessionInfo } from "../../session/manager.js";
import { ingestSessionInfoForCache } from "../../session/cache-manager.js";
import { getCurrentProject } from "../../settings/manager.js";
import { clearAllInteractionState } from "../../interaction/cleanup.js";
import { isForegroundBusy, replyBusyBlocked } from "../utils/busy-guard.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { attachToSession } from "../../attach/service.js";

export interface NewCommandDeps {
  bot: Bot<Context>;
  ensureEventSubscription: (directory: string) => Promise<void>;
}

export async function newCommand(ctx: CommandContext<Context>, deps: NewCommandDeps) {
  try {
    if (isForegroundBusy()) {
      await replyBusyBlocked(ctx);
      return;
    }

    const currentProject = getCurrentProject();

    if (!currentProject) {
      await ctx.reply(t("new.project_not_selected"));
      return;
    }

    logger.debug("[Bot] Creating new session for directory:", currentProject.worktree);

    const { data: session, error } = await opencodeClient.session.create({
      directory: currentProject.worktree,
    });

    if (error || !session) {
      throw error || new Error("No data received from server");
    }

    logger.info(
      `[Bot] Created new session via /new command: id=${session.id}, title="${session.title}", project=${currentProject.worktree}`,
    );

    const sessionInfo: SessionInfo = {
      id: session.id,
      title: session.title,
      directory: currentProject.worktree,
    };
    setCurrentSession("telegram", sessionInfo);
    clearAllInteractionState("session_created");
    await ingestSessionInfoForCache(session);

    await attachToSession({
      bot: deps.bot,
      chatId: ctx.chat.id,
      session: sessionInfo,
      ensureEventSubscription: deps.ensureEventSubscription,
    });

    await ctx.reply(t("new.created", { title: session.title }));
  } catch (error) {
    logger.error("[Bot] Error creating session:", error);
    await ctx.reply(t("new.create_error"));
  }
}
