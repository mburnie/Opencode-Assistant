import type { V2Event } from "@opencode/client/promise";
import type { Bot } from "grammy";
import type { CodeFileData } from "./formatter.js";
import { normalizePathForDisplay, prepareCodeFile } from "./formatter.js";
import type { PermissionRequest } from "../permission/types.js";
import type { FormInfo } from "@opencode/client/promise";
import type { FileChange } from "../pinned/types.js";
import { logger } from "../utils/logger.js";
import { getCurrentProject } from "../settings/manager.js";
import {
  countDiffChangesFromText,
  extractFirstUpdatedFileFromTitle,
} from "./aggregator-helpers.js";
import { SubagentTracker } from "./subagent-tracker.js";
import type { SubagentCallback } from "./subagent-tracker.js";

/** Minimal tool-state shape used by the aggregator and subagent tracker. */
export interface ToolState {
  status: "streaming" | "running" | "completed" | "error";
  input?: { [key: string]: unknown };
  output?: unknown;
  error?: unknown;
  title?: string;
  metadata?: { [key: string]: unknown };
  time?: { start?: number; completed?: number };
}

export type { SubagentCallback, SubagentInfo, SubagentStatus } from "./subagent-tracker.js";

export interface SummaryInfo {
  sessionId: string;
  text: string;
  messageCount: number;
  lastUpdated: number;
}

export interface MessageCompletionInfo {
  agent?: string;
  providerID?: string;
  modelID?: string;
  createdAt?: number;
  completedAt?: number;
}

type MessageCompleteCallback = (
  sessionId: string,
  messageId: string,
  messageText: string,
  completionInfo: MessageCompletionInfo,
) => void;

type MessagePartialCallback = (sessionId: string, messageId: string, messageText: string) => void;

type ExternalUserInputCallback = (
  sessionId: string,
  messageId: string,
  messageText: string,
) => void | Promise<void>;

export interface ToolInfo {
  sessionId: string;
  messageId: string;
  callId: string;
  tool: string;
  state: ToolState;
  input?: { [key: string]: unknown };
  title?: string;
  metadata?: { [key: string]: unknown };
  hasFileAttachment?: boolean;
}

export interface ToolFileInfo extends ToolInfo {
  hasFileAttachment: true;
  fileData: CodeFileData;
}

type ToolCallback = (toolInfo: ToolInfo) => void;

type ToolFileCallback = (fileInfo: ToolFileInfo) => void;

type FormCallback = (form: FormInfo, sessionId: string) => void;

type FormRepliedCallback = (formId: string, sessionId: string) => void;

type FormCancelledCallback = (formId: string, sessionId: string) => void;

type ThinkingCallback = (sessionId: string) => void;

export interface TokensInfo {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

type TokensCallback = (tokens: TokensInfo, isCompleted: boolean) => void;

type CostCallback = (cost: number) => void;

type SessionCompactedCallback = (sessionId: string, directory: string) => void;

type SessionErrorCallback = (sessionId: string, message: string) => void;

export interface SessionRetryInfo {
  sessionId: string;
  attempt?: number;
  message: string;
  next?: number;
}

type SessionRetryCallback = (retryInfo: SessionRetryInfo) => void;

type SessionIdleCallback = (sessionId: string) => void;

type PermissionCallback = (request: PermissionRequest) => void;

type FileChangeCallback = (change: FileChange) => void;

type ClearedCallback = () => void;

interface PreparedToolFileContext {
  fileData: CodeFileData | null;
  fileChange: FileChange | null;
}

interface TextMessageState {
  orderedPartIds: string[];
  partTexts: Map<string, string>;
  optimisticUpdateCount: number;
}

class SummaryAggregator {
  private currentSessionId: string | null = null;
  private textMessageStates: Map<string, TextMessageState> = new Map();
  private messages: Map<string, { role: string }> = new Map();
  private messageCount = 0;
  private lastUpdated = 0;
  private onCompleteCallback: MessageCompleteCallback | null = null;
  private onPartialCallback: MessagePartialCallback | null = null;
  private onExternalUserInputCallback: ExternalUserInputCallback | null = null;
  private onToolCallback: ToolCallback | null = null;
  private onToolFileCallback: ToolFileCallback | null = null;
  private onFormCallback: FormCallback | null = null;
  private onFormRepliedCallback: FormRepliedCallback | null = null;
  private onFormCancelledCallback: FormCancelledCallback | null = null;
  private onThinkingCallback: ThinkingCallback | null = null;
  private onTokensCallback: TokensCallback | null = null;
  private onCostCallback: CostCallback | null = null;
  private onSessionCompactedCallback: SessionCompactedCallback | null = null;
  private onSessionErrorCallback: SessionErrorCallback | null = null;
  private onSessionRetryCallback: SessionRetryCallback | null = null;
  private onSessionIdleCallback: SessionIdleCallback | null = null;
  private onPermissionCallback: PermissionCallback | null = null;
  private onFileChangeCallback: FileChangeCallback | null = null;
  private onClearedCallback: ClearedCallback | null = null;
  private processedToolStates: Set<string> = new Set();
  private thinkingFiredForMessages: Set<string> = new Set();
  private deliveredExternalUserMessageIds: Set<string> = new Set();
  private bot: Bot | null = null;
  private chatId: number | null = null;
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private typingIndicatorEnabled = true;
  private partHashes: Map<string, Set<string>> = new Map();
  private trackedSessionParents: Map<string, string | null> = new Map();
  private pendingChildSessionIdsByParent: Map<string, string[]> = new Map();
  private subagentTracker: SubagentTracker = new SubagentTracker(
    this.trackedSessionParents,
    this.pendingChildSessionIdsByParent,
    () => this.currentSessionId,
  );

  setBotAndChatId(bot: Bot, chatId: number): void {
    this.bot = bot;
    this.chatId = chatId;
  }

  setOnComplete(callback: MessageCompleteCallback): void {
    this.onCompleteCallback = callback;
  }

  setOnPartial(callback: MessagePartialCallback): void {
    this.onPartialCallback = callback;
  }

  setOnExternalUserInput(callback: ExternalUserInputCallback): void {
    this.onExternalUserInputCallback = callback;
  }

  setOnTool(callback: ToolCallback): void {
    this.onToolCallback = callback;
  }

  setOnToolFile(callback: ToolFileCallback): void {
    this.onToolFileCallback = callback;
  }

  setOnForm(callback: FormCallback): void {
    this.onFormCallback = callback;
  }

  setOnFormReplied(callback: FormRepliedCallback): void {
    this.onFormRepliedCallback = callback;
  }

  setOnFormCancelled(callback: FormCancelledCallback): void {
    this.onFormCancelledCallback = callback;
  }

  setOnThinking(callback: ThinkingCallback): void {
    this.onThinkingCallback = callback;
  }

  setOnTokens(callback: TokensCallback): void {
    this.onTokensCallback = callback;
  }

  setOnCost(callback: CostCallback): void {
    this.onCostCallback = callback;
  }

  setOnSubagent(callback: SubagentCallback): void {
    this.subagentTracker.setCallback(callback);
  }

  setOnSessionCompacted(callback: SessionCompactedCallback): void {
    this.onSessionCompactedCallback = callback;
  }

  setOnSessionError(callback: SessionErrorCallback): void {
    this.onSessionErrorCallback = callback;
  }

  setOnSessionRetry(callback: SessionRetryCallback): void {
    this.onSessionRetryCallback = callback;
  }

  setOnSessionIdle(callback: SessionIdleCallback): void {
    this.onSessionIdleCallback = callback;
  }

  setOnPermission(callback: PermissionCallback): void {
    this.onPermissionCallback = callback;
  }

  setOnFileChange(callback: FileChangeCallback): void {
    this.onFileChangeCallback = callback;
  }

  setOnCleared(callback: ClearedCallback): void {
    this.onClearedCallback = callback;
  }

  setTypingIndicatorEnabled(enabled: boolean): void {
    this.typingIndicatorEnabled = enabled;

    if (!enabled) {
      this.stopTypingIndicator();
    }
  }

  private startTypingIndicator(): void {
    if (!this.typingIndicatorEnabled) {
      return;
    }

    if (this.typingTimer) {
      return;
    }

    const sendTyping = () => {
      if (this.bot && this.chatId) {
        this.bot.api.sendChatAction(this.chatId, "typing").catch((err) => {
          logger.error("Failed to send typing action:", err);
        });
      }
    };

    sendTyping();
    this.typingTimer = setInterval(sendTyping, 4000);
  }

  stopTypingIndicator(): void {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }

  processEvent(event: V2Event): void {
    const eventType = event.type;

    // Log all session-related events for debugging
    if (eventType.startsWith("session.")) {
      logger.debug(
        `[Aggregator] Session event: ${eventType}`,
        JSON.stringify((event as unknown as { data?: unknown }).data, null, 2),
      );
    }

    switch (event.type) {
      case "session.created":
      case "session.renamed":
      case "session.metadata.updated":
        this.handleSessionCreatedOrUpdated(event);
        break;
      case "session.text.started":
        this.handleTextStarted(event);
        break;
      case "session.text.delta":
        this.handleTextDelta(event);
        break;
      case "session.text.ended":
        this.handleTextEnded(event);
        break;
      case "session.reasoning.started":
        this.handleReasoningStarted(event);
        break;
      case "session.tool.called":
        this.handleToolCalled(event);
        break;
      case "session.tool.progress":
        this.handleToolProgress(event);
        break;
      case "session.tool.success":
      case "session.tool.failed":
        this.handleToolTerminal(event);
        break;
      case "session.tool.input.started":
      case "session.tool.input.delta":
      case "session.tool.input.ended":
        break; // streaming input — no aggregator action
      case "session.status":
        this.handleSessionStatus(event);
        break;
      case "session.idle":
        this.handleSessionIdle(event);
        break;
      case "session.compaction.started":
      case "session.compaction.ended":
      case "session.compaction.delta":
        this.handleSessionCompaction(event);
        break;
      case "session.execution.failed":
        this.handleSessionExecutionFailed(event);
        break;
      case "session.execution.interrupted":
        this.handleSessionExecutionInterrupted(event);
        break;
      case "session.retry.scheduled":
        this.handleSessionRetryScheduled(event);
        break;
      case "session.usage.updated":
        this.handleSessionUsageUpdated(event);
        break;
      case "session.step.ended":
        this.handleSessionStepEnded(event);
        break;
      case "session.inbox.delivered":
      case "session.inbox.enqueued":
        this.handleSessionInboxDelivered(event);
        break;
      case "session.permissions":
        break; // handled through permission.asked
      case "permission.asked":
        this.handlePermissionAsked(event);
        break;
      case "permission.replied":
        logger.info(`[Aggregator] Permission replied: requestID=${(event as any).data?.id}`);
        break;
      case "form.created":
        this.handleFormCreated(event);
        break;
      case "form.replied":
        this.handleFormReplied(event);
        break;
      case "form.cancelled":
        this.handleFormCancelled(event);
        break;
      case "session.step.started":
      case "session.step.streamed":
      case "session.step.failed":
      case "session.reasoning.delta":
      case "session.reasoning.ended":
      case "session.compaction.failed":
      case "session.shell.started":
      case "session.shell.ended":
      case "session.skill.activated":
      case "session.agent.selected":
      case "session.model.selected":
      case "session.viewed":
      case "session.deleted":
      case "session.forked":
      case "session.moved":
      case "session.revert.staged":
      case "session.revert.cleared":
      case "session.revert.committed":
      case "filesystem.changed":
      case "reference.updated":
      case "session.instructions.updated":
      case "session.synthetic":
      case "session.inbox.cancelled":
      case "session.inbox.delivery.changed":
      case "session.execution.started":
      case "session.execution.succeeded":
        // Handled elsewhere or no aggregator action needed
        break;
      default:
        logger.debug(`[Aggregator] Unhandled event type: ${eventType}`);
        break;
    }
  }

  setSession(sessionId: string): void {
    if (this.currentSessionId !== sessionId) {
      this.clear();
      this.currentSessionId = sessionId;
      this.trackedSessionParents.set(sessionId, null);
    }
  }

  clear(): void {
    this.stopTypingIndicator();
    this.currentSessionId = null;
    this.textMessageStates.clear();
    this.messages.clear();
    this.partHashes.clear();
    this.processedToolStates.clear();
    this.thinkingFiredForMessages.clear();
    this.deliveredExternalUserMessageIds.clear();
    this.trackedSessionParents.clear();
    this.pendingChildSessionIdsByParent.clear();
    this.subagentTracker.clear();
    this.messageCount = 0;
    this.lastUpdated = 0;

    if (this.onClearedCallback) {
      try {
        this.onClearedCallback();
      } catch (err) {
        logger.error("[Aggregator] Error in clear callback:", err);
      }
    }
  }

  private isTrackedChildSession(sessionId: string): boolean {
    return this.trackedSessionParents.has(sessionId) && sessionId !== this.currentSessionId;
  }

  private handleSessionCreatedOrUpdated(event: V2Event): void {
    if (!this.currentSessionId) return;

    let sessionID: string | undefined;
    let parentID: string | undefined;
    let title: string | undefined;

    if (event.type === "session.created") {
      sessionID = event.data.sessionID;
      parentID = event.data.parentID;
      title = event.data.title;
    } else if (event.type === "session.renamed") {
      sessionID = event.data.sessionID;
      title = event.data.title;
    } else if (event.type === "session.metadata.updated") {
      sessionID = event.data.sessionID;
      title = (event.data as { metadata?: { title?: string } }).metadata?.title;
    }

    if (!sessionID || !parentID) return;
    if (!this.trackedSessionParents.has(parentID)) return;
    if (sessionID === this.currentSessionId) return;

    if (!this.trackedSessionParents.has(sessionID)) {
      this.subagentTracker.trackChildSession(sessionID, parentID);
    }

    this.subagentTracker.handleChildSessionInfo({
      id: sessionID,
      parentID,
      title,
    });
  }

  // ─── Text events (V2 native) ────────────────────────────────────────

  private handleTextStarted(event: V2Event): void {
    if (event.type !== "session.text.started") return;
    const { sessionID, assistantMessageID, ordinal } = event.data;

    if (sessionID !== this.currentSessionId && !this.isTrackedChildSession(sessionID)) return;

    if (sessionID === this.currentSessionId) {
      const textState = this.getOrCreateTextMessageState(assistantMessageID);
      if (!this.messages.has(assistantMessageID)) {
        this.messages.set(assistantMessageID, { role: "assistant" });
        this.messageCount++;
        this.startTypingIndicator();
      }
      // Use ordinal as partID to order text blocks
      const partID = `text-${ordinal}`;
      this.registerTextPart(assistantMessageID, partID);
    }
    this.lastUpdated = Date.now();
  }

  private handleTextDelta(event: V2Event): void {
    if (event.type !== "session.text.delta") return;
    const { sessionID, assistantMessageID, delta } = event.data;

    if (sessionID !== this.currentSessionId) return;

    const partID = `text-${(event as { data: { ordinal?: number } }).data.ordinal ?? 0}`;
    this.registerTextPart(assistantMessageID, partID);

    const state = this.getOrCreateTextMessageState(assistantMessageID);
    const previous = state.partTexts.get(partID) || "";
    state.partTexts.set(partID, previous + delta);

    const combined = this.getCombinedMessageText(assistantMessageID);
    if (!combined.trim()) return;

    this.startTypingIndicator();
    this.emitPartialText(sessionID, assistantMessageID, combined);
    this.lastUpdated = Date.now();
  }

  private handleTextEnded(event: V2Event): void {
    if (event.type !== "session.text.ended") return;
    const { sessionID, assistantMessageID, ordinal, text } = event.data;

    if (sessionID !== this.currentSessionId) return;

    const partID = `text-${ordinal}`;

    // Register the message if not already tracked
    if (!this.messages.has(assistantMessageID)) {
      this.messages.set(assistantMessageID, { role: "assistant" });
      this.messageCount++;
      this.startTypingIndicator();
    }

    this.registerTextPart(assistantMessageID, partID);

    const state = this.getOrCreateTextMessageState(assistantMessageID);
    state.partTexts.set(partID, text);

    const combined = this.getCombinedMessageText(assistantMessageID);
    if (!combined.trim()) return;

    this.emitPartialText(sessionID, assistantMessageID, combined);
    this.lastUpdated = Date.now();
  }

  private handleReasoningStarted(event: V2Event): void {
    if (event.type !== "session.reasoning.started") return;
    const { sessionID, assistantMessageID } = event.data;

    if (sessionID !== this.currentSessionId) return;

    if (!this.thinkingFiredForMessages.has(assistantMessageID)) {
      this.thinkingFiredForMessages.add(assistantMessageID);
      if (this.onThinkingCallback) {
        const callback = this.onThinkingCallback;
        setImmediate(() => {
          if (typeof callback === "function") {
            callback(sessionID);
          }
        });
      }
    }
    this.lastUpdated = Date.now();
  }

  // ─── Tool events (V2 native) ────────────────────────────────────────

  private handleToolCalled(event: V2Event): void {
    if (event.type !== "session.tool.called") return;
    const { sessionID, assistantMessageID, id, input, executed } = event.data;

    const isCurrentRoot = sessionID === this.currentSessionId;
    const isTrackedChild = this.isTrackedChildSession(sessionID);

    if (!isCurrentRoot && !isTrackedChild) {
      this.subagentTracker.attachUnknownSessionToPendingSubagent(sessionID);
      return;
    }

    const toolName = (input as Record<string, unknown>)?.tool as string | undefined;

    if (isTrackedChild) {
      if (toolName === "task") {
        this.subagentTracker.updateFromTaskTool(sessionID, input as { [key: string]: unknown });
      }
      this.subagentTracker.updateToolState(
        sessionID,
        { status: "running", input: input as { [key: string]: unknown } },
        toolName ?? "unknown",
        input as { [key: string]: unknown },
        undefined,
      );
      this.lastUpdated = Date.now();
      return;
    }

    // Root session tool tracking
    if (toolName === "task") {
      this.subagentTracker.updateFromTaskTool(sessionID, input as { [key: string]: unknown });
    }

    const toolData: ToolInfo = {
      sessionId: sessionID,
      messageId: assistantMessageID,
      callId: id,
      tool: toolName ?? "unknown",
      state: { status: "running", input: input as { [key: string]: unknown } },
      input: input as { [key: string]: unknown },
    };

    this.lastUpdated = Date.now();
  }

  private handleToolProgress(event: V2Event): void {
    if (event.type !== "session.tool.progress") return;
    const { sessionID, id, metadata } = event.data;

    if (sessionID !== this.currentSessionId && !this.isTrackedChildSession(sessionID)) return;

    if (this.isTrackedChildSession(sessionID)) {
      const toolName = (metadata as Record<string, unknown>)?.tool as string | undefined;
      this.subagentTracker.updateToolState(
        sessionID,
        { status: "running" },
        toolName ?? "unknown",
        undefined,
        (metadata as Record<string, unknown>)?.title as string | undefined,
      );
    }
    this.lastUpdated = Date.now();
  }

  private handleToolTerminal(event: V2Event): void {
    const isFailed = event.type === "session.tool.failed";
    if (event.type !== "session.tool.success" && !isFailed) return;
    const { sessionID, assistantMessageID, id, metadata } = event.data;

    const isCurrentRoot = sessionID === this.currentSessionId;
    const isTrackedChild = this.isTrackedChildSession(sessionID);

    if (!isCurrentRoot && !isTrackedChild) return;

    const input = isFailed
      ? (event.data as { input?: { [key: string]: unknown } }).input
      : undefined;
    const toolName = (metadata as Record<string, unknown>)?.tool as string | undefined;

    if (isTrackedChild) {
      this.subagentTracker.updateToolState(
        sessionID,
        { status: isFailed ? "error" : "completed" },
        toolName ?? "unknown",
        input as { [key: string]: unknown } | undefined,
        (metadata as Record<string, unknown>)?.title as string | undefined,
      );
      this.lastUpdated = Date.now();
      return;
    }

    // Root session: fire onToolCallback
    const completedKey = `completed-${id}`;
    if (!this.processedToolStates.has(completedKey)) {
      this.processedToolStates.add(completedKey);

      const toolData: ToolInfo = {
        sessionId: sessionID,
        messageId: assistantMessageID,
        callId: id,
        tool: toolName ?? "unknown",
        state: {
          status: isFailed ? "error" : "completed",
          input: input as { [key: string]: unknown } | undefined,
          error: isFailed ? (event.data as { error?: unknown }).error : undefined,
          metadata: metadata as { [key: string]: unknown } | undefined,
        },
        input: input as { [key: string]: unknown } | undefined,
        metadata: metadata as { [key: string]: unknown } | undefined,
        hasFileAttachment: false,
      };

      if (this.onToolCallback) {
        this.onToolCallback(toolData);
      }

      const preparedFileContext = this.prepareToolFileContext(
        toolData.tool,
        toolData.input,
        toolData.title,
        toolData.metadata,
      );
      if (preparedFileContext.fileData && this.onToolFileCallback) {
        this.onToolFileCallback({
          ...toolData,
          hasFileAttachment: true,
          fileData: preparedFileContext.fileData,
        });
      }
      if (preparedFileContext.fileChange && this.onFileChangeCallback) {
        this.onFileChangeCallback(preparedFileContext.fileChange);
      }
    }
    this.lastUpdated = Date.now();
  }

  private applyTextDelta(
    sessionID: string,
    messageID: string,
    partID: string,
    delta: string,
    fullTextHint?: string,
  ): void {
    if (sessionID !== this.currentSessionId) return;
    this.registerTextPart(messageID, partID);

    const state = this.getOrCreateTextMessageState(messageID);
    const previous = state.partTexts.get(partID) || "";
    let accumulated = `${previous}${delta}`;
    if (typeof fullTextHint === "string" && fullTextHint.length > accumulated.length) {
      accumulated = fullTextHint;
    }
    state.partTexts.set(partID, accumulated);

    const combined = this.getCombinedMessageText(messageID);
    if (!combined.trim()) return;

    const messageInfo = this.messages.get(messageID);
    if (messageInfo?.role === "user") {
      this.emitExternalUserInputIfReady(sessionID, messageID);
      return;
    }
    this.startTypingIndicator();
    this.emitPartialText(sessionID, messageID, combined);
  }

  private emitExternalUserInputIfReady(sessionId: string, messageId: string): void {
    if (sessionId !== this.currentSessionId || this.deliveredExternalUserMessageIds.has(messageId)) {
      return;
    }
    const messageInfo = this.messages.get(messageId);
    if (!messageInfo || messageInfo.role !== "user") return;
    const messageText = this.getCombinedMessageText(messageId).trim();
    if (!messageText) return;

    this.deliveredExternalUserMessageIds.add(messageId);
    this.cleanupCompletedMessage(messageId);

    if (!this.onExternalUserInputCallback) return;
    const callback = this.onExternalUserInputCallback;
    setImmediate(() => {
      Promise.resolve(callback(sessionId, messageId, messageText)).catch((err) => {
        logger.error("[Aggregator] Error in external user input callback:", err);
      });
    });
  }

  private cleanupCompletedMessage(messageId: string): void {
    this.textMessageStates.delete(messageId);
    this.messages.delete(messageId);
    this.partHashes.delete(messageId);
    if (this.textMessageStates.size === 0) {
      this.stopTypingIndicator();
    }
  }

  private emitPartialText(sessionId: string, messageId: string, messageText: string): void {
    if (!this.onPartialCallback || !messageText.trim()) return;
    try {
      this.onPartialCallback(sessionId, messageId, messageText);
    } catch (err) {
      logger.error("[Aggregator] Error in partial callback:", err);
    }
  }

  private getOrCreateTextMessageState(messageID: string): TextMessageState {
    const existing = this.textMessageStates.get(messageID);
    if (existing) return existing;
    const state: TextMessageState = {
      orderedPartIds: [],
      partTexts: new Map(),
      optimisticUpdateCount: 0,
    };
    this.textMessageStates.set(messageID, state);
    return state;
  }

  private registerTextPart(messageID: string, partID: string): void {
    const state = this.getOrCreateTextMessageState(messageID);
    if (!state.orderedPartIds.includes(partID)) {
      state.orderedPartIds.push(partID);
    }
  }

  private getCombinedMessageText(messageID: string): string {
    const state = this.textMessageStates.get(messageID);
    if (!state) {
      return "";
    }

    return state.orderedPartIds.map((partID) => state.partTexts.get(partID) || "").join("");
  }

  private prepareToolFileContext(
    tool: string,
    input: { [key: string]: unknown } | undefined,
    title: string | undefined,
    metadata: { [key: string]: unknown } | undefined,
  ): PreparedToolFileContext {
    if (tool === "write" && input) {
      const filePath =
        typeof input.filePath === "string" ? normalizePathForDisplay(input.filePath) : "";
      const hasContent = typeof input.content === "string";
      const content = hasContent ? (input.content as string) : "";

      if (!filePath || !hasContent) {
        return { fileData: null, fileChange: null };
      }

      return {
        fileData: prepareCodeFile(content, filePath, "write"),
        fileChange: {
          file: filePath,
          additions: content.split("\n").length,
          deletions: 0,
        },
      };
    }

    if (tool === "edit" && metadata) {
      const editMetadata = metadata as {
        diff?: unknown;
        filediff?: { file?: string; additions?: number; deletions?: number };
      };
      const filePath = editMetadata.filediff?.file
        ? normalizePathForDisplay(editMetadata.filediff.file)
        : "";
      const diffText = typeof editMetadata.diff === "string" ? editMetadata.diff : "";

      if (!filePath || !diffText) {
        return { fileData: null, fileChange: null };
      }

      return {
        fileData: prepareCodeFile(diffText, filePath, "edit"),
        fileChange: {
          file: filePath,
          additions: editMetadata.filediff?.additions || 0,
          deletions: editMetadata.filediff?.deletions || 0,
        },
      };
    }

    if (tool === "apply_patch") {
      const patchMetadata = metadata as
        | {
            filediff?: { file?: string; additions?: number; deletions?: number };
            diff?: string;
          }
        | undefined;

      const filePathFromInput =
        input && typeof input.filePath === "string"
          ? normalizePathForDisplay(input.filePath)
          : input && typeof input.path === "string"
            ? normalizePathForDisplay(input.path)
            : "";
      const filePathFromTitle = title ? extractFirstUpdatedFileFromTitle(title) : "";

      const filePath =
        (patchMetadata?.filediff?.file && normalizePathForDisplay(patchMetadata.filediff.file)) ||
        filePathFromInput ||
        normalizePathForDisplay(filePathFromTitle);
      const diffText =
        typeof patchMetadata?.diff === "string"
          ? patchMetadata.diff
          : input && typeof input.patchText === "string"
            ? input.patchText
            : "";

      if (!filePath) {
        return { fileData: null, fileChange: null };
      }

      const fileChange = patchMetadata?.filediff
        ? {
            file: filePath,
            additions: patchMetadata.filediff.additions || 0,
            deletions: patchMetadata.filediff.deletions || 0,
          }
        : diffText
          ? (() => {
              const changes = countDiffChangesFromText(diffText);
              return {
                file: filePath,
                additions: changes.additions,
                deletions: changes.deletions,
              };
            })()
          : null;

      return {
        fileData: diffText ? prepareCodeFile(diffText, filePath, "edit") : null,
        fileChange,
      };
    }

    return { fileData: null, fileChange: null };
  }

  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  private handleSessionStatus(event: V2Event): void {
    if (event.type !== "session.status") return;
    const { sessionID, status } = event.data;

    if (sessionID !== this.currentSessionId) return;

    // Only retry status needs aggregator attention
    if (status.type === "retry" && this.onSessionRetryCallback) {
      const callback = this.onSessionRetryCallback;
      const message = status.message?.trim() || "Unknown retry error";
      setImmediate(() => {
        callback({
          sessionId: sessionID,
          attempt: status.attempt,
          message,
          next: status.next,
        });
      });
    }
  }

  private handleSessionIdle(event: V2Event): void {
    if (event.type !== "session.idle") return;
    const { sessionID } = event.data;

    if (this.isTrackedChildSession(sessionID)) {
      this.subagentTracker.setTerminalStatus(sessionID, "completed");
      return;
    }

    if (sessionID !== this.currentSessionId) return;

    this.stopTypingIndicator();

    // Flush any accumulated assistant messages
    if (this.onCompleteCallback && this.textMessageStates.size > 0) {
      const messagesToFlush = Array.from(this.textMessageStates.keys());
      const callback = this.onCompleteCallback;
      const flushImpl = async () => {
        for (const messageID of messagesToFlush) {
          const finalText = this.getCombinedMessageText(messageID);
          if (!finalText.trim()) {
            this.cleanupCompletedMessage(messageID);
            continue;
          }
          try {
            callback(sessionID, messageID, finalText, {});
          } catch (err) {
            logger.error("[Aggregator] Error in onComplete during idle flush:", err);
          }
          this.cleanupCompletedMessage(messageID);
        }
      };
      const idleCb = this.onSessionIdleCallback;
      flushImpl()
        .catch((err) => {
          logger.error("[Aggregator] Idle flush failed:", err);
        })
        .finally(() => {
          if (idleCb) {
            setImmediate(() => idleCb(sessionID));
          }
        });
      return;
    }

    if (this.onSessionIdleCallback) {
      const callback = this.onSessionIdleCallback;
      setImmediate(() => {
        callback(sessionID);
      });
    }
  }

  private handleSessionCompaction(event: V2Event): void {
    if (event.type !== "session.compaction.ended") return;
    const { sessionID } = event.data;
    if (sessionID !== this.currentSessionId) return;

    if (this.onSessionCompactedCallback) {
      setImmediate(() => {
        const project = getCurrentProject();
        if (project) {
          this.onSessionCompactedCallback!(sessionID, project.worktree);
        }
      });
    }
  }

  private handleSessionExecutionFailed(event: V2Event): void {
    if (event.type !== "session.execution.failed") return;
    const { sessionID, error } = event.data;

    const message = error?.message || "Unknown session error";

    if (this.isTrackedChildSession(sessionID)) {
      this.subagentTracker.setTerminalStatus(sessionID, "error", message);
      return;
    }

    if (sessionID !== this.currentSessionId) return;
    this.stopTypingIndicator();

    if (this.onSessionErrorCallback) {
      const callback = this.onSessionErrorCallback;
      setImmediate(() => {
        callback(sessionID, message);
      });
    }
  }

  private handleSessionExecutionInterrupted(event: V2Event): void {
    if (event.type !== "session.execution.interrupted") return;
    const { sessionID } = event.data;

    if (this.isTrackedChildSession(sessionID)) {
      this.subagentTracker.setTerminalStatus(sessionID, "error", "interrupted");
      return;
    }

    if (sessionID !== this.currentSessionId) return;
    this.stopTypingIndicator();

    if (this.onSessionErrorCallback) {
      const callback = this.onSessionErrorCallback;
      setImmediate(() => {
        callback(sessionID, "Session interrupted");
      });
    }
  }

  private handleSessionRetryScheduled(event: V2Event): void {
    if (event.type !== "session.retry.scheduled") return;
    const { sessionID } = event.data;

    if (sessionID !== this.currentSessionId) return;
    // Retry info is part of session.status with type=retry, handled there
  }

  private handleSessionUsageUpdated(event: V2Event): void {
    if (event.type !== "session.usage.updated") return;
    const { sessionID, tokens, cost } = event.data;

    if (sessionID !== this.currentSessionId) return;

    if (this.onTokensCallback && tokens) {
      const tokensInfo: TokensInfo = {
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cacheRead: tokens.cache?.read ?? 0,
        cacheWrite: tokens.cache?.write ?? 0,
      };
      this.onTokensCallback(tokensInfo, true);
    }

    if (this.onCostCallback && cost !== undefined) {
      this.onCostCallback(cost);
    }
  }

  private handleSessionStepEnded(event: V2Event): void {
    if (event.type !== "session.step.ended") return;
    const { sessionID, cost, tokens } = event.data;

    if (sessionID !== this.currentSessionId) return;

    if (this.onTokensCallback && tokens) {
      const tokensInfo: TokensInfo = {
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cacheRead: tokens.cache?.read ?? 0,
        cacheWrite: tokens.cache?.write ?? 0,
      };
      this.onTokensCallback(tokensInfo, false);
    }

    if (this.onCostCallback && cost !== undefined) {
      this.onCostCallback(cost);
    }
  }

  private handleSessionInboxDelivered(event: V2Event): void {
    if (event.type !== "session.inbox.delivered" && event.type !== "session.inbox.enqueued") return;
    const { sessionID } = event.data;

    if (sessionID !== this.currentSessionId) return;

    // V2 uses inbox events for external user input. We emit a notification
    // for now — the actual message text comes from the event stream via
    // session.context, not from the event itself.
    // This is a minimal bridge until full native user message support.
    if (this.onExternalUserInputCallback) {
      const callback = this.onExternalUserInputCallback;
      const inboxId = event.data.inboxID;
      setImmediate(() => {
        Promise.resolve(callback(sessionID, inboxId, "")).catch((err) => {
          logger.error("[Aggregator] Error in external user input callback:", err);
        });
      });
    }
  }

  private handleFormCreated(event: V2Event): void {
    if (event.type !== "form.created") return;
    const form = event.data.form as FormInfo;
    const sessionID = form.sessionID;

    if (sessionID !== this.currentSessionId) return;

    if (this.onFormCallback) {
      const callback = this.onFormCallback;
      setImmediate(async () => {
        try {
          await callback(form, sessionID);
        } catch (err) {
          logger.error("[Aggregator] Error in form callback:", err);
        }
      });
    }
  }

  private handleFormReplied(event: V2Event): void {
    if (event.type !== "form.replied") return;
    const { id, sessionID } = event.data;

    if (sessionID !== this.currentSessionId) return;

    if (this.onFormRepliedCallback) {
      const callback = this.onFormRepliedCallback;
      setImmediate(async () => {
        try {
          await callback(id, sessionID);
        } catch (err) {
          logger.error("[Aggregator] Error in form replied callback:", err);
        }
      });
    }
  }

  private handleFormCancelled(event: V2Event): void {
    if (event.type !== "form.cancelled") return;
    const { id, sessionID } = event.data;

    if (sessionID !== this.currentSessionId) return;

    if (this.onFormCancelledCallback) {
      const callback = this.onFormCancelledCallback;
      setImmediate(async () => {
        try {
          await callback(id, sessionID);
        } catch (err) {
          logger.error("[Aggregator] Error in form cancelled callback:", err);
        }
      });
    }
  }

  private handlePermissionAsked(event: V2Event): void {
    if (event.type !== "permission.asked") return;
    const request = event.data;

    if (request.sessionID !== this.currentSessionId) return;

    if (this.onPermissionCallback) {
      const callback = this.onPermissionCallback;
      setImmediate(async () => {
        try {
          await callback(request as unknown as PermissionRequest);
        } catch (err) {
          logger.error("[Aggregator] Error in permission callback:", err);
        }
      });
    }
  }
}

export const summaryAggregator = new SummaryAggregator();
