import { Context, InlineKeyboard } from "grammy";
import {
  getAvailableVariants,
  getCurrentVariant,
  setCurrentVariant,
  formatVariantForDisplay,
} from "../../variant/manager.js";
import { getStoredModel } from "../../model/manager.js";
import { logger } from "../../utils/logger.js";
import {
  clearActiveInlineMenu,
  ensureActiveInlineMenu,
  replyWithInlineMenu,
} from "./inline-menu.js";
import { t } from "../../i18n/index.js";

/**
 * Handle variant selection callback
 * @param ctx grammY context
 * @returns true if handled, false otherwise
 */
export async function handleVariantSelect(ctx: Context): Promise<boolean> {
  const callbackQuery = ctx.callbackQuery;

  if (!callbackQuery?.data || !callbackQuery.data.startsWith("variant:")) {
    return false;
  }

  const isActiveMenu = await ensureActiveInlineMenu(ctx, "variant");
  if (!isActiveMenu) {
    return true;
  }

  logger.debug(`[VariantHandler] Received callback: ${callbackQuery.data}`);

  try {
    const variantId = callbackQuery.data.replace("variant:", "");

    const currentModel = getStoredModel();

    if (!currentModel.providerID || !currentModel.modelID) {
      logger.error("[VariantHandler] No model selected");
      await ctx.answerCallbackQuery({ text: t("variant.model_not_selected_callback") });
      return false;
    }

    setCurrentVariant(variantId);

    const displayName = formatVariantForDisplay(variantId);

    clearActiveInlineMenu("variant_selected");

    await ctx.answerCallbackQuery({ text: t("variant.changed_callback", { name: displayName }) });
    await ctx.reply(t("variant.changed_message", { name: displayName }));

    await ctx.deleteMessage().catch(() => {});

    return true;
  } catch (err) {
    clearActiveInlineMenu("variant_select_error");
    logger.error("[VariantHandler] Error handling variant select:", err);
    await ctx.answerCallbackQuery({ text: t("variant.change_error_callback") }).catch(() => {});
    return false;
  }
}

/**
 * Build inline keyboard with available variants
 * @param currentVariant Current variant for highlighting
 * @param providerID Provider ID
 * @param modelID Model ID
 * @returns InlineKeyboard with variant selection buttons
 */
export async function buildVariantSelectionMenu(
  currentVariant: string,
  providerID: string,
  modelID: string,
): Promise<InlineKeyboard> {
  const keyboard = new InlineKeyboard();
  const variants = await getAvailableVariants(providerID, modelID);

  if (variants.length === 0) {
    logger.warn("[VariantHandler] No variants found");
    return keyboard;
  }

  // Filter only active variants (not disabled)
  const activeVariants = variants.filter((v) => !v.disabled);

  if (activeVariants.length === 0) {
    logger.warn("[VariantHandler] No active variants found");
    // If no active variants, show default at least
    keyboard.text(`✅ ${formatVariantForDisplay("default")}`, "variant:default").row();
    return keyboard;
  }

  // Add button for each variant (one per row)
  activeVariants.forEach((variant) => {
    const isActive = variant.id === currentVariant;
    const label = formatVariantForDisplay(variant.id);
    const labelWithCheck = isActive ? `✅ ${label}` : label;

    keyboard.text(labelWithCheck, `variant:${variant.id}`).row();
  });

  return keyboard;
}

/**
 * Show variant selection menu
 * @param ctx grammY context
 */
export async function showVariantSelectionMenu(ctx: Context): Promise<void> {
  try {
    const currentModel = getStoredModel();

    if (!currentModel.providerID || !currentModel.modelID) {
      await ctx.reply(t("variant.select_model_first"));
      return;
    }

    const currentVariant = getCurrentVariant();
    const keyboard = await buildVariantSelectionMenu(
      currentVariant,
      currentModel.providerID,
      currentModel.modelID,
    );

    if (keyboard.inline_keyboard.length === 0) {
      await ctx.reply(t("variant.menu.empty"));
      return;
    }

    const displayName = formatVariantForDisplay(currentVariant);
    const text = t("variant.menu.current", { name: displayName });

    await replyWithInlineMenu(ctx, {
      menuKind: "variant",
      text,
      keyboard,
    });
  } catch (err) {
    logger.error("[VariantHandler] Error showing variant menu:", err);
    await ctx.reply(t("variant.menu.error"));
  }
}
