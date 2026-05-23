import { Context, InlineKeyboard } from "grammy";
import {
  clearActiveInlineMenu,
  ensureActiveInlineMenu,
  replyWithInlineMenu,
} from "../handlers/inline-menu.js";
import { showAgentSelectionMenu } from "../handlers/agent.js";
import { showModelSelectionMenu } from "../handlers/model.js";
import { showVariantSelectionMenu } from "../handlers/variant.js";
import { handleContextButtonPress } from "../handlers/context.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";

export async function settingsCommand(ctx: Context): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text(t("settings.button.agent"), "settings:agent")
    .row()
    .text(t("settings.button.model"), "settings:model")
    .row()
    .text(t("settings.button.variant"), "settings:variant")
    .row()
    .text(t("settings.button.context"), "settings:context");

  await replyWithInlineMenu(ctx, {
    menuKind: "settings",
    text: t("settings.select"),
    keyboard,
  });
}

export async function handleSettingsSelect(ctx: Context): Promise<boolean> {
  const callbackQuery = ctx.callbackQuery;
  if (!callbackQuery?.data || !callbackQuery.data.startsWith("settings:")) {
    return false;
  }

  const isActiveMenu = await ensureActiveInlineMenu(ctx, "settings");
  if (!isActiveMenu) {
    return true;
  }

  const action = callbackQuery.data.slice("settings:".length);

  try {
    switch (action) {
      case "agent":
        clearActiveInlineMenu("settings_selected");
        await ctx.deleteMessage().catch(() => {});
        await ctx.answerCallbackQuery().catch(() => {});
        await showAgentSelectionMenu(ctx);
        break;
      case "model":
        clearActiveInlineMenu("settings_selected");
        await ctx.deleteMessage().catch(() => {});
        await ctx.answerCallbackQuery().catch(() => {});
        await showModelSelectionMenu(ctx);
        break;
      case "variant":
        clearActiveInlineMenu("settings_selected");
        await ctx.deleteMessage().catch(() => {});
        await ctx.answerCallbackQuery().catch(() => {});
        await showVariantSelectionMenu(ctx);
        break;
      case "context":
        clearActiveInlineMenu("settings_selected");
        await ctx.deleteMessage().catch(() => {});
        await ctx.answerCallbackQuery().catch(() => {});
        await handleContextButtonPress(ctx);
        break;
      default:
        await ctx.answerCallbackQuery({ text: t("callback.unknown_command") });
        return true;
    }

    return true;
  } catch (err) {
    clearActiveInlineMenu("settings_error");
    logger.error("[Settings] Error handling settings select:", err);
    await ctx.answerCallbackQuery({ text: t("callback.processing_error") }).catch(() => {});
    return false;
  }
}
