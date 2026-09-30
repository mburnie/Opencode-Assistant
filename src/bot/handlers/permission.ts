import { Context, InlineKeyboard } from "grammy";
import { permissionManager } from "../../permission/manager.js";
import { replyToPermission } from "../../opencode/client-v2.js";
import { getCurrentSession } from "../../session/manager.js";
import { summaryAggregator } from "../../summary/aggregator.js";
import { interactionManager } from "../../interaction/manager.js";
import { logger } from "../../utils/logger.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { PermissionRequest, PermissionReply } from "../../permission/types.js";
import type { I18nKey } from "../../i18n/en.js";
import { t } from "../../i18n/index.js";

// Permission type display names
const PERMISSION_NAME_KEYS: Record<string, I18nKey> = {
  bash: "permission.name.bash",
  edit: "permission.name.edit",
  write: "permission.name.write",
  read: "permission.name.read",
  webfetch: "permission.name.webfetch",
  websearch: "permission.name.websearch",
  glob: "permission.name.glob",
  grep: "permission.name.grep",
  list: "permission.name.list",
  task: "permission.name.task",
  lsp: "permission.name.lsp",
  external_directory: "permission.name.external_directory",
};

// Permission type emojis
const PERMISSION_EMOJIS: Record<string, string> = {
  bash: "⚡",
  edit: "✏️",
  write: "📝",
  read: "📖",
  webfetch: "🌐",
  websearch: "🔍",
  glob: "📁",
  grep: "🔎",
  list: "📂",
  task: "⚙️",
  lsp: "🔧",
  external_directory: "📁",
};

function getCallbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) {
    return null;
  }

  const messageId = (message as { message_id?: number }).message_id;
  return typeof messageId === "number" ? messageId : null;
}

function clearPermissionInteraction(reason: string): void {
  const state = interactionManager.getSnapshot();
  if (state?.kind === "permission") {
    interactionManager.clear(reason);
  }
}

function syncPermissionInteractionState(metadata: Record<string, unknown> = {}): void {
  const pendingCount = permissionManager.getPendingCount();

  if (pendingCount === 0) {
    clearPermissionInteraction("permission_no_pending_requests");
    return;
  }

  const nextMetadata: Record<string, unknown> = {
    pendingCount,
    ...metadata,
  };

  const state = interactionManager.getSnapshot();
  if (state?.kind === "permission") {
    interactionManager.transition({
      expectedInput: "callback",
      metadata: nextMetadata,
    });
    return;
  }

  interactionManager.start({
    kind: "permission",
    expectedInput: "callback",
    metadata: nextMetadata,
  });
}

function isPermissionReply(value: string): value is PermissionReply {
  return value === "once" || value === "always" || value === "reject";
}

/**
 * Handle permission callback from inline buttons
 */
export async function handlePermissionCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data) return false;

  if (!data.startsWith("permission:")) {
    return false;
  }

  logger.debug(`[PermissionHandler] Received callback: ${data}`);

  if (!permissionManager.isActive()) {
    clearPermissionInteraction("permission_inactive_callback");
    await ctx.answerCallbackQuery({ text: t("permission.inactive_callback"), show_alert: true });
    return true;
  }

  const callbackMessageId = getCallbackMessageId(ctx);
  if (!permissionManager.isActiveMessage(callbackMessageId)) {
    await ctx.answerCallbackQuery({ text: t("permission.inactive_callback"), show_alert: true });
    return true;
  }

  const requestID = permissionManager.getRequestID(callbackMessageId);
  if (!requestID) {
    await ctx.answerCallbackQuery({ text: t("permission.inactive_callback"), show_alert: true });
    return true;
  }

  const parts = data.split(":");
  let action = parts[1];

  // Security: continuing/always approval is disabled. A stale "always"
  // callback (from an old message) is downgraded to a rejection so the
  // pending request is resolved with deny-by-default and never persists.
  if (action === "always") {
    logger.warn(
      "[PermissionHandler] Rejecting legacy 'always' permission callback: " +
        "continuing approvals are disabled",
    );
    action = "reject";
  }

  if (!isPermissionReply(action)) {
    await ctx.answerCallbackQuery({
      text: t("permission.processing_error_callback"),
      show_alert: true,
    });
    return true;
  }

  try {
    await handlePermissionReply(ctx, action, requestID, callbackMessageId);
  } catch (err) {
    logger.error("[PermissionHandler] Error handling callback:", err);
    await ctx.answerCallbackQuery({
      text: t("permission.processing_error_callback"),
      show_alert: true,
    });
  }

  return true;
}

/**
 * Handle permission reply (once/always/reject)
 */
async function handlePermissionReply(
  ctx: Context,
  reply: PermissionReply,
  requestID: string,
  callbackMessageId: number | null,
): Promise<void> {
  const currentSession = getCurrentSession();
  const chatId = ctx.chat?.id;

  if (!currentSession || !chatId) {
    permissionManager.clear();
    clearPermissionInteraction("permission_invalid_runtime_context");

    await ctx.answerCallbackQuery({
      text: t("permission.no_active_request_callback"),
      show_alert: true,
    });
    return;
  }

  // Reply labels for user feedback
  const replyLabels: Record<PermissionReply, string> = {
    once: t("permission.reply.once"),
    always: t("permission.reply.always"),
    reject: t("permission.reply.reject"),
  };

  await ctx.answerCallbackQuery({ text: replyLabels[reply] });

  // Delete the permission message
  await ctx.deleteMessage().catch(() => {});

  // Stop typing indicator since we're responding
  summaryAggregator.stopTypingIndicator();

  logger.info(`[PermissionHandler] Sending permission reply: ${reply}, requestID=${requestID}`);

  // CRITICAL: Fire-and-forget! Do not block the handler
  safeBackgroundTask({
    taskName: "permission.reply",
    task: () =>
      replyToPermission(currentSession.id, requestID, reply),
    onSuccess: ({ error }) => {
      if (error) {
        logger.error("[PermissionHandler] Failed to send permission reply:", error);
        if (ctx.api && chatId) {
          void ctx.api.sendMessage(chatId, t("permission.send_reply_error")).catch(() => {});
        }
        return;
      }

      logger.info("[PermissionHandler] Permission reply sent successfully");
    },
  });

  permissionManager.removeByMessageId(callbackMessageId);

  if (!permissionManager.isActive()) {
    clearPermissionInteraction("permission_replied");
    return;
  }

  syncPermissionInteractionState({
    lastRepliedRequestID: requestID,
  });
}

/**
 * Show permission request message with inline buttons
 */
export async function showPermissionRequest(
  bot: Context["api"],
  chatId: number,
  request: PermissionRequest,
): Promise<void> {
  logger.debug(`[PermissionHandler] Showing permission request: ${request.permission ?? "unknown"}`);

  const text = formatPermissionText(request);
  const keyboard = buildPermissionKeyboard();

  try {
    const message = await bot.sendMessage(chatId, text, {
      reply_markup: keyboard,
    });

    logger.debug(`[PermissionHandler] Message sent, messageId=${message.message_id}`);
    permissionManager.startPermission(request, message.message_id);

    syncPermissionInteractionState({
      requestID: request.id,
      messageId: message.message_id,
    });

    summaryAggregator.stopTypingIndicator();
  } catch (err) {
    logger.error("[PermissionHandler] Failed to send permission message:", err);
    throw err;
  }
}

/**
 * Extract a human-readable tool name from permission metadata, if present.
 *
 * V2 permission payloads for MCP tools (e.g. the memory server) carry the
 * tool identity under `metadata.toolCalls`. This is best-effort: any shape
 * is tolerated and a missing/unknown name simply yields `null`.
 */
function extractToolName(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const toolCalls = (metadata as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return null;
  }

  const first = toolCalls[0];
  if (!first || typeof first !== "object") {
    return null;
  }

  const call = first as { tool?: unknown; name?: unknown; toolName?: unknown };
  const candidate = call.tool ?? call.name ?? call.toolName;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

/**
 * Format permission request text.
 *
 * Defensive by design: `permission`, `patterns`, and `metadata` may be
 * missing or malformed (e.g. V2 payloads that omit `action`). This must
 * never throw for missing optional fields.
 */
function formatPermissionText(request: PermissionRequest): string {
  const permission = typeof request.permission === "string" ? request.permission : "";
  const patterns = Array.isArray(request.patterns) ? request.patterns : [];
  const toolName = extractToolName(request.metadata);

  const emoji = PERMISSION_EMOJIS[permission] || "🔐";
  const nameKey = PERMISSION_NAME_KEYS[permission];

  let name: string;
  if (nameKey) {
    name = t(nameKey);
  } else if (permission) {
    // Unknown but present permission type: show the raw identifier.
    name = permission;
  } else if (toolName) {
    // Missing permission type: safe generic label plus the tool name.
    name = t("permission.name.generic_tool", { tool: toolName });
  } else {
    // Nothing usable at all: fully generic, still safe.
    name = t("permission.name.generic");
  }

  let text = t("permission.header", { emoji, name });

  // Show patterns (commands/files). Guard against non-string entries.
  patterns
    .filter((pattern): pattern is string => typeof pattern === "string")
    .forEach((pattern) => {
      text += `• ${pattern}\n`;
    });

  return text;
}

/**
 * Build inline keyboard with permission buttons.
 *
 * Security: only "Allow once" and "Reject" are offered. A one-shot approval
 * never extends into broad or continuing permission, so there is deliberately
 * no "Allow always" button. Stale callbacks that carry an "always" decision
 * (e.g. from an older message) are denied below.
 */
function buildPermissionKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  keyboard.text(t("permission.button.allow"), "permission:once").row();
  keyboard.text(t("permission.button.reject"), "permission:reject");

  return keyboard;
}
