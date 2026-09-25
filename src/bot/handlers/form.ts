import { Context, InlineKeyboard } from "grammy";
import type { FormInfo, FormField, FormOption } from "@opencode/client/promise";
import type { FieldAnswerValue } from "../../form/types.js";
import { formManager } from "../../form/manager.js";
import { replyToForm, cancelForm } from "../../opencode/client-v2.js";
import { summaryAggregator } from "../../summary/aggregator.js";
import { interactionManager } from "../../interaction/manager.js";
import { logger } from "../../utils/logger.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { t } from "../../i18n/index.js";

const MAX_BUTTON_LENGTH = 60;

function getCallbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) {
    return null;
  }

  const messageId = (message as { message_id?: number }).message_id;
  return typeof messageId === "number" ? messageId : null;
}

function clearFormInteraction(reason: string): void {
  const state = interactionManager.getSnapshot();
  if (state?.kind === "form") {
    interactionManager.clear(reason);
  }
}

function syncFormInteractionState(
  expectedInput: "callback" | "mixed",
  fieldIndex: number,
  messageId: number | null,
): void {
  const metadata: Record<string, unknown> = {
    fieldIndex,
    inputMode: expectedInput === "mixed" ? "custom" : "options",
  };

  const formID = formManager.getFormId();
  if (formID) {
    metadata.formID = formID;
  }

  if (messageId !== null) {
    metadata.messageId = messageId;
  }

  const state = interactionManager.getSnapshot();
  if (state?.kind === "form") {
    interactionManager.transition({
      expectedInput,
      metadata,
    });
    return;
  }

  interactionManager.start({
    kind: "form",
    expectedInput,
    metadata,
  });
}

export async function handleFormCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data) return false;

  if (!data.startsWith("form:")) {
    return false;
  }

  logger.debug(`[FormHandler] Received callback: ${data}`);

  if (!formManager.isActive()) {
    clearFormInteraction("form_inactive_callback");
    await ctx.answerCallbackQuery({ text: t("form.inactive_callback"), show_alert: true });
    return true;
  }

  const callbackMessageId = getCallbackMessageId(ctx);
  if (!formManager.isActiveMessage(callbackMessageId)) {
    await ctx.answerCallbackQuery({ text: t("form.inactive_callback"), show_alert: true });
    return true;
  }

  const parts = data.split(":");
  const action = parts[1];

  try {
    switch (action) {
      case "sel":
        {
          const fieldIndex = parseInt(parts[2], 10);
          const optionIndex = parseInt(parts[3], 10);
          if (Number.isNaN(fieldIndex) || Number.isNaN(optionIndex)) {
            await ctx.answerCallbackQuery({
              text: t("form.processing_error_callback"),
              show_alert: true,
            });
            break;
          }
          await handleSelectOption(ctx, fieldIndex, optionIndex);
        }
        break;
      case "sub":
        {
          const fieldIndex = parseInt(parts[2], 10);
          if (Number.isNaN(fieldIndex)) {
            await ctx.answerCallbackQuery({
              text: t("form.processing_error_callback"),
              show_alert: true,
            });
            break;
          }
          await handleSubmitField(ctx, fieldIndex);
        }
        break;
      case "cst":
        {
          const fieldIndex = parseInt(parts[2], 10);
          if (Number.isNaN(fieldIndex)) {
            await ctx.answerCallbackQuery({
              text: t("form.processing_error_callback"),
              show_alert: true,
            });
            break;
          }
          await handleCustomInput(ctx, fieldIndex);
        }
        break;
      case "bool":
        {
          const fieldIndex = parseInt(parts[2], 10);
          const value = parts[3] === "1";
          if (Number.isNaN(fieldIndex)) {
            await ctx.answerCallbackQuery({
              text: t("form.processing_error_callback"),
              show_alert: true,
            });
            break;
          }
          await handleBooleanAnswer(ctx, fieldIndex, value);
        }
        break;
      case "cnl":
        await handleCancelForm(ctx);
        break;
      default:
        await ctx.answerCallbackQuery({
          text: t("form.processing_error_callback"),
          show_alert: true,
        });
        break;
    }
  } catch (err) {
    logger.error("[FormHandler] Error handling callback:", err);
    await ctx.answerCallbackQuery({
      text: t("form.processing_error_callback"),
      show_alert: true,
    });
  }

  return true;
}

async function handleSelectOption(
  ctx: Context,
  fieldIndex: number,
  optionIndex: number,
): Promise<void> {
  logger.debug(`[FormHandler] handleSelectOption: fIndex=${fieldIndex}, oIndex=${optionIndex}`);

  const field = formManager.getCurrentField();
  if (!field || formManager.getCurrentFieldIndex() !== fieldIndex) {
    await ctx.answerCallbackQuery({ text: t("form.inactive_callback"), show_alert: true });
    return;
  }

  if (formManager.isWaitingForCustomInput(fieldIndex)) {
    formManager.clearCustomInput();
    syncFormInteractionState("callback", fieldIndex, formManager.getActiveMessageId());
  }

  formManager.selectOption(fieldIndex, optionIndex);

  if (field.type === "multiselect") {
    logger.debug("[FormHandler] Multiselect mode, updating message");
    await updateFormFieldMessage(ctx);
    await ctx.answerCallbackQuery();
  } else if (field.type === "string" && field.options && field.options.length > 0) {
    logger.debug("[FormHandler] Single select string option, moving to next field");
    await ctx.answerCallbackQuery();

    const value = getOptionValue(field.options, optionIndex);
    if (value !== undefined) {
      formManager.setAnswer(field.key, value);
    }

    await ctx.deleteMessage().catch(() => {});
    await showNextField(ctx);
  } else {
    await ctx.answerCallbackQuery();
  }
}

async function handleSubmitField(ctx: Context, fieldIndex: number): Promise<void> {
  if (formManager.isWaitingForCustomInput(fieldIndex)) {
    formManager.clearCustomInput();
    syncFormInteractionState("callback", fieldIndex, formManager.getActiveMessageId());
  }

  const field = formManager.getCurrentField();
  if (!field || formManager.getCurrentFieldIndex() !== fieldIndex) {
    await ctx.answerCallbackQuery({ text: t("form.inactive_callback"), show_alert: true });
    return;
  }

  const answer = formManager.getSelectedAnswer(fieldIndex);
  const values = Array.isArray(answer) ? answer : [];

  if (values.length === 0) {
    await ctx.answerCallbackQuery({
      text: t("form.select_one_required_callback"),
      show_alert: true,
    });
    return;
  }

  logger.debug(`[FormHandler] Submit field ${fieldIndex}: ${JSON.stringify(answer)}`);
  if (answer !== undefined) {
    formManager.setAnswer(field.key, answer);
  }

  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
  await showNextField(ctx);
}

async function handleCustomInput(ctx: Context, fieldIndex: number): Promise<void> {
  const field = formManager.getCurrentField();
  if (!field || formManager.getCurrentFieldIndex() !== fieldIndex) {
    await ctx.answerCallbackQuery({ text: t("form.inactive_callback"), show_alert: true });
    return;
  }

  formManager.startCustomInput(fieldIndex);
  syncFormInteractionState("mixed", fieldIndex, formManager.getActiveMessageId());

  await ctx.answerCallbackQuery({
    text: t("form.enter_custom_callback"),
    show_alert: true,
  });
}

async function handleBooleanAnswer(
  ctx: Context,
  fieldIndex: number,
  value: boolean,
): Promise<void> {
  const field = formManager.getCurrentField();
  if (!field || field.type !== "boolean" || formManager.getCurrentFieldIndex() !== fieldIndex) {
    await ctx.answerCallbackQuery({ text: t("form.inactive_callback"), show_alert: true });
    return;
  }

  logger.debug(`[FormHandler] Boolean answer for field ${fieldIndex}: ${value}`);
  formManager.setAnswer(field.key, value);

  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
  await showNextField(ctx);
}

async function handleCancelForm(ctx: Context): Promise<void> {
  const sessionID = formManager.getSessionID();
  const formID = formManager.getFormId();

  formManager.cancel();
  clearFormInteraction("form_cancelled");

  await ctx.editMessageText(t("form.cancelled")).catch(() => {});
  await ctx.answerCallbackQuery();

  if (sessionID && formID) {
    safeBackgroundTask({
      taskName: "form.cancel",
      task: () => cancelForm(sessionID, formID),
      onSuccess: ({ error }) => {
        if (error) {
          logger.error("[FormHandler] Failed to cancel form:", error);
        } else {
          logger.info("[FormHandler] Form cancelled successfully");
        }
      },
    });
  }

  formManager.clear();
}

async function updateFormFieldMessage(ctx: Context): Promise<void> {
  const field = formManager.getCurrentField();
  if (!field) {
    return;
  }

  const text = formatFieldText(field);
  const keyboard = buildFieldKeyboard(
    field,
    formManager.getSelectedOptions(formManager.getCurrentFieldIndex()),
  );

  try {
    await ctx.editMessageText(text, {
      reply_markup: keyboard,
    });
  } catch (err) {
    logger.error("[FormHandler] Failed to update message:", err);
  }
}

export async function showCurrentFormField(bot: Context["api"], chatId: number): Promise<void> {
  const field = formManager.getCurrentField();

  if (!field) {
    await showFormSummary(bot, chatId);
    return;
  }

  logger.debug(`[FormHandler] Showing field: ${field.key} (${field.type})`);

  const text = formatFieldText(field);
  const keyboard = buildFieldKeyboard(
    field,
    formManager.getSelectedOptions(formManager.getCurrentFieldIndex()),
  );

  try {
    const message = await bot.sendMessage(chatId, text, {
      reply_markup: keyboard,
    });

    logger.debug(`[FormHandler] Message sent, messageId=${message.message_id}`);

    formManager.addMessageId(message.message_id);
    formManager.setActiveMessageId(message.message_id);
    syncFormInteractionState(
      isTextInputField(field) ? "mixed" : "callback",
      formManager.getCurrentFieldIndex(),
      formManager.getActiveMessageId(),
    );

    summaryAggregator.stopTypingIndicator();
  } catch (err) {
    formManager.clear();
    clearFormInteraction("form_message_send_failed");

    logger.error("[FormHandler] Failed to send form message:", err);
    throw err;
  }
}

export async function handleFormTextAnswer(ctx: Context): Promise<void> {
  const text = ctx.message?.text;
  if (!text) return;

  const currentIndex = formManager.getCurrentFieldIndex();

  if (!formManager.isWaitingForCustomInput(currentIndex)) {
    await ctx.reply(t("form.use_custom_button_first"));
    return;
  }

  if (formManager.hasAnswer(formManager.getCurrentField()?.key ?? "")) {
    await ctx.reply(t("form.answer_already_received"));
    return;
  }

  const field = formManager.getCurrentField();
  if (!field) {
    return;
  }

  logger.debug(`[FormHandler] Custom text answer for field ${currentIndex}: ${text}`);

  const parsed = parseTextAnswer(field, text);
  if (parsed.error) {
    await ctx.reply(parsed.error);
    return;
  }

  formManager.setAnswer(field.key, parsed.value);
  formManager.clearCustomInput();

  const activeMessageId = formManager.getActiveMessageId();
  if (activeMessageId !== null && ctx.chat) {
    await ctx.api.deleteMessage(ctx.chat.id, activeMessageId).catch(() => {});
  }

  await showNextField(ctx);
}

async function showNextField(ctx: Context): Promise<void> {
  formManager.nextField();

  if (!ctx.chat) {
    return;
  }

  if (formManager.hasNextField()) {
    await showCurrentFormField(ctx.api, ctx.chat.id);
  } else {
    await showFormSummary(ctx.api, ctx.chat.id);
  }
}

async function showFormSummary(bot: Context["api"], chatId: number): Promise<void> {
  const answers = formManager.getAllAnswers();
  const totalFields = formManager.getTotalFields();

  logger.info(`[FormHandler] Form completed, answered ${Object.keys(answers).length}/${totalFields} fields`);

  await sendAnswersToAgent(bot, chatId);

  if (Object.keys(answers).length === 0) {
    await bot.sendMessage(chatId, t("form.completed_no_answers"));
  } else {
    const summary = formatAnswersSummary(answers);
    await bot.sendMessage(chatId, summary);
  }

  clearFormInteraction("form_completed");
  formManager.clear();
}

async function sendAnswersToAgent(bot: Context["api"], chatId: number): Promise<void> {
  const sessionID = formManager.getSessionID();
  const formID = formManager.getFormId();
  const answers = formManager.getAllAnswers();

  if (!sessionID || !formID) {
    logger.error("[FormHandler] No active form for sending answers");
    await bot.sendMessage(chatId, t("form.no_active_request"));
    return;
  }

  if (Object.keys(answers).length === 0) {
    logger.info("[FormHandler] No answers to send; cancelling form instead");
    safeBackgroundTask({
      taskName: "form.cancel",
      task: () => cancelForm(sessionID, formID),
      onSuccess: ({ error }) => {
        if (error) {
          logger.error("[FormHandler] Failed to cancel empty form:", error);
        }
      },
    });
    return;
  }

  logger.info(`[FormHandler] Sending form answers via session.form.reply: formID=${formID}`);
  logger.debug(`[FormHandler] Answers payload:`, JSON.stringify(answers, null, 2));

  safeBackgroundTask({
    taskName: "form.reply",
    task: () => replyToForm(sessionID, formID, answers),
    onSuccess: ({ error }) => {
      if (error) {
        logger.error("[FormHandler] Failed to send answers via session.form.reply:", error);
        void bot.sendMessage(chatId, t("form.send_answers_error")).catch(() => {});
        return;
      }

      logger.info("[FormHandler] Form answers sent successfully via session.form.reply");
    },
  });
}

function formatFieldText(field: FormField): string {
  const currentIndex = formManager.getCurrentFieldIndex();
  const totalFields = formManager.getTotalFields();
  const progressText = totalFields > 0 ? `${currentIndex + 1}/${totalFields}` : "";

  const title = field.title || field.key;
  const headerTitle = [progressText, title].filter(Boolean).join(" ");
  const header = headerTitle ? `${headerTitle}\n\n` : "";
  const description = field.description ? `${field.description}\n\n` : "";
  const required =
    field.type !== "external" && field.required !== false ? t("form.required_hint") : "";

  let body = "";
  if (field.type === "external") {
    body = `${t("form.external_link")}: ${field.url}`;
  } else if (field.type === "boolean") {
    body = field.description || title;
  } else if (field.type === "multiselect") {
    body = `${t("form.multi_hint")}`;
  } else if (field.type === "string" && (!field.options || field.options.length === 0)) {
    const placeholder = field.placeholder
      ? `\n${t("form.placeholder")}: ${field.placeholder}`
      : "";
    body = `${t("form.text_hint")}${placeholder}`;
  } else if (field.type === "number" || field.type === "integer") {
    const range = buildNumberRangeHint(field);
    body = `${t("form.number_hint")}${range}`;
  }

  return `${header}${description}${body}${required}`;
}

function buildNumberRangeHint(field: FormField): string {
  if (field.type !== "number" && field.type !== "integer") {
    return "";
  }

  const parts: string[] = [];
  if (field.minimum !== undefined) {
    parts.push(`${t("form.min")}: ${field.minimum}`);
  }
  if (field.maximum !== undefined) {
    parts.push(`${t("form.max")}: ${field.maximum}`);
  }

  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function buildFieldKeyboard(field: FormField, selectedOptions: Set<number>): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const fieldIndex = formManager.getCurrentFieldIndex();

  if (field.type === "boolean") {
    keyboard.text(t("form.button.yes"), `form:bool:${fieldIndex}:1`).row();
    keyboard.text(t("form.button.no"), `form:bool:${fieldIndex}:0`).row();
  } else if (field.type === "external") {
    keyboard.url(t("form.button.open_link"), field.url).row();
  } else if (
    (field.type === "string" || field.type === "multiselect") &&
    field.options &&
    field.options.length > 0
  ) {
    field.options.forEach((option, index) => {
      const isSelected = selectedOptions.has(index);
      const icon = isSelected ? "✅ " : "";
      const buttonText = formatButtonText(option.label, option.description || "", icon);
      const callbackData = `form:sel:${fieldIndex}:${index}`;

      keyboard.text(buttonText, callbackData).row();
    });

    if (field.type === "multiselect") {
      keyboard.text(t("form.button.submit"), `form:sub:${fieldIndex}`).row();
    }
  }

  if (isTextInputField(field)) {
    keyboard.text(t("form.button.custom"), `form:cst:${fieldIndex}`).row();
  }

  keyboard.text(t("form.button.cancel"), "form:cnl");

  return keyboard;
}

function isTextInputField(field: FormField): boolean {
  if (field.type === "string" && (!field.options || field.options.length === 0)) {
    return true;
  }
  if (field.type === "number" || field.type === "integer") {
    return true;
  }
  return false;
}

function formatButtonText(label: string, description: string, icon: string): string {
  let text = `${icon}${label}`;

  if (description && icon === "") {
    text += ` - ${description}`;
  }

  if (text.length > MAX_BUTTON_LENGTH) {
    text = text.substring(0, MAX_BUTTON_LENGTH - 3) + "...";
  }

  return text;
}

function getOptionValue(options: FormOption[], index: number): string | undefined {
  return options[index]?.value;
}

function parseTextAnswer(
  field: FormField,
  text: string,
): { value: FieldAnswerValue; error?: string } {
  if (field.type === "number") {
    const num = Number(text);
    if (Number.isNaN(num)) {
      return { value: text, error: t("form.invalid_number") };
    }
    if (field.minimum !== undefined && num < Number(field.minimum)) {
      return { value: text, error: t("form.number_too_small", { min: String(field.minimum) }) };
    }
    if (field.maximum !== undefined && num > Number(field.maximum)) {
      return { value: text, error: t("form.number_too_large", { max: String(field.maximum) }) };
    }
    return { value: num };
  }

  if (field.type === "integer") {
    const num = Number(text);
    if (!Number.isInteger(num)) {
      return { value: text, error: t("form.invalid_integer") };
    }
    if (field.minimum !== undefined && num < Number(field.minimum)) {
      return { value: text, error: t("form.number_too_small", { min: String(field.minimum) }) };
    }
    if (field.maximum !== undefined && num > Number(field.maximum)) {
      return { value: text, error: t("form.number_too_large", { max: String(field.maximum) }) };
    }
    return { value: num };
  }

  return { value: text };
}

function formatAnswersSummary(answers: Record<string, FieldAnswerValue>): string {
  let summary = t("form.summary.title");

  const form = formManager.getForm();
  if (!form) {
    return summary;
  }

  form.fields.forEach((field, index) => {
    const value = answers[field.key];
    if (value === undefined) {
      return;
    }

    const title = field.title || field.key;
    let answerText: string;
    if (Array.isArray(value)) {
      answerText = value.join(", ");
    } else if (typeof value === "boolean") {
      answerText = value ? t("form.boolean_true") : t("form.boolean_false");
    } else {
      answerText = String(value);
    }

    summary += t("form.summary.field", {
      index: index + 1,
      field: title,
    });
    summary += t("form.summary.answer", { answer: answerText });
  });

  return summary;
}

export function handleFormCreated(form: FormInfo, sessionId: string): void {
  logger.info(`[FormHandler] Form created event received: formID=${form.id}, sessionID=${sessionId}`);
  formManager.startForm(form);
}

export function handleFormReplied(formId: string, sessionId: string): void {
  logger.info(`[FormHandler] Form replied event received: formID=${formId}, sessionID=${sessionId}`);
  if (formManager.getFormId() === formId) {
    formManager.clear();
    clearFormInteraction("form_replied_event");
  }
}

export function handleFormCancelled(formId: string, sessionId: string): void {
  logger.info(`[FormHandler] Form cancelled event received: formID=${formId}, sessionID=${sessionId}`);
  if (formManager.getFormId() === formId) {
    formManager.clear();
    clearFormInteraction("form_cancelled_event");
  }
}
