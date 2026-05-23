import { Context } from "grammy";
import { pinnedMessageManager } from "../../pinned/manager.js";
import { clearSession } from "../../session/manager.js";
import { clearProject } from "../../settings/manager.js";
import { foregroundSessionState } from "../../scheduled-task/foreground-state.js";
import { abortCurrentOperation } from "./abort.js";
import { t } from "../../i18n/index.js";
import { assistantRunState } from "../assistant-run-state.js";
import { detachAttachedSession } from "../../attach/service.js";

export async function startCommand(ctx: Context): Promise<void> {
  if (ctx.chat) {
    if (!pinnedMessageManager.isInitialized()) {
      pinnedMessageManager.initialize(ctx.api, ctx.chat.id);
    }
  }

  await abortCurrentOperation(ctx, { notifyUser: false });
  detachAttachedSession("start_command_reset");
  foregroundSessionState.clearAll("start_command_reset");
  assistantRunState.clearAll("start_command_reset");

  clearSession();
  clearProject();
  await pinnedMessageManager.clear();

  if (pinnedMessageManager.getContextLimit() === 0) {
    await pinnedMessageManager.refreshContextLimit();
  }

  await ctx.reply(t("start.welcome"), {
    reply_markup: { remove_keyboard: true },
  });
}
