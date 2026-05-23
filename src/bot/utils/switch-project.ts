import type { Context } from "grammy";
import type { ProjectInfo } from "../../settings/manager.js";
import { setCurrentProject } from "../../settings/manager.js";
import { clearSession } from "../../session/manager.js";
import { summaryAggregator } from "../../summary/aggregator.js";
import { pinnedMessageManager } from "../../pinned/manager.js";
import { detachAttachedSession } from "../../attach/service.js";
import { clearAllInteractionState } from "../../interaction/cleanup.js";
import { logger } from "../../utils/logger.js";

export async function switchToProject(ctx: Context, project: ProjectInfo, reason: string) {
  detachAttachedSession(reason);
  setCurrentProject(project);
  clearSession();
  summaryAggregator.clear();
  clearAllInteractionState(reason);

  try {
    await pinnedMessageManager.clear();
  } catch (err) {
    logger.error("[Bot] Error clearing pinned message:", err);
  }

  await pinnedMessageManager.refreshContextLimit();
}
