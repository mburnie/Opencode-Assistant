import { createSession } from "../../opencode/client-v2.js";
import { setCurrentSession, type SessionInfo } from "../../session/manager.js";
import { ingestSessionInfoForCache } from "../../session/cache-manager.js";
import { getCurrentProject } from "../../settings/manager.js";
import { clearAllInteractionState } from "../../interaction/cleanup.js";
import { logger } from "../../utils/logger.js";
import type { WhatsAppCommandHandler } from "./types.js";

export const newCommand: WhatsAppCommandHandler = async (ctx) => {
  const project = getCurrentProject();

  if (!project) {
    await ctx.reply(
      "No project selected. Open Telegram and pick one with /projects first.",
    );
    return;
  }

  try {
    const { data: session, error } = await createSession({
      directory: project.worktree,
    });

    if (error || !session) {
      throw error || new Error("No data returned from server");
    }

    const title = session.title ?? "Untitled";

    logger.info(
      `[WhatsApp][new] Created session id=${session.id} title="${title}" dir=${project.worktree}`,
    );

    const info: SessionInfo = {
      id: session.id,
      title,
      directory: project.worktree,
    };
    setCurrentSession("whatsapp", info);
    clearAllInteractionState("whatsapp_session_created");
    await ingestSessionInfoForCache(session);

    await ctx.reply(`✅ New session: *${title}*`);
  } catch (err) {
    logger.error("[WhatsApp][new] failed to create session", err);
    await ctx.reply("Could not create a new session.");
  }
};
