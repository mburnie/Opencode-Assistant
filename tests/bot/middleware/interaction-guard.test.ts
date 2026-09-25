import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, NextFunction } from "grammy";
import { interactionGuardMiddleware } from "../../../src/bot/middleware/interaction-guard.js";
import { interactionManager } from "../../../src/interaction/manager.js";
import { foregroundSessionState } from "../../../src/scheduled-task/foreground-state.js";
import { attachManager } from "../../../src/attach/manager.js";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  currentSession: null as { id: string; title: string; directory: string } | null,
  getActiveSessionsMock: vi.fn(),
}));

vi.mock("../../../src/session/manager.js", () => ({
  getCurrentSession: vi.fn(() => mocked.currentSession),
}));

vi.mock("../../../src/opencode/client-v2.js", () => ({
  getActiveSessions: mocked.getActiveSessionsMock,
}));

function createTextContext(text: string): Context {
  return {
    chat: { id: 1 },
    message: { text } as Context["message"],
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

function createCallbackContext(data: string): Context {
  return {
    callbackQuery: { data } as Context["callbackQuery"],
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

function createVoiceContext(): Context {
  return {
    chat: { id: 1 },
    message: { voice: { file_id: "voice-file-id" } } as Context["message"],
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

describe("interactionGuardMiddleware", () => {
  beforeEach(() => {
    interactionManager.clear("test_setup");
    foregroundSessionState.__resetForTests();
    attachManager.__resetForTests();
    mocked.currentSession = null;
    mocked.getActiveSessionsMock.mockReset();
  });

  it("passes through when there is no active interaction", async () => {
    const ctx = createTextContext("hello");
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("blocks text and replies when callback is expected", async () => {
    interactionManager.start({
      kind: "inline",
      expectedInput: "callback",
    });

    const ctx = createTextContext("hello");
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("inline.blocked.expected_choice"));
  });

  it("blocks callback and answers callback query when text is expected", async () => {
    interactionManager.start({
      kind: "rename",
      expectedInput: "text",
    });

    const ctx = createCallbackContext("project:123");
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("rename.blocked.expected_name"),
    });
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("allows command from allowed list", async () => {
    interactionManager.start({
      kind: "inline",
      expectedInput: "callback",
      allowedCommands: ["/status"],
    });

    const ctx = createTextContext("/status");
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("always allows /start even when command list is restricted", async () => {
    interactionManager.start({
      kind: "inline",
      expectedInput: "callback",
      allowedCommands: ["/status"],
    });

    const ctx = createTextContext("/start");
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("blocks disallowed command", async () => {
    interactionManager.start({
      kind: "inline",
      expectedInput: "callback",
      allowedCommands: ["/status"],
    });

    const ctx = createTextContext("/help");
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("inline.blocked.command_not_allowed"));
  });

  it("shows permission-specific message for blocked text", async () => {
    interactionManager.start({
      kind: "permission",
      expectedInput: "callback",
    });

    const ctx = createTextContext("hello");
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("permission.blocked.expected_reply"));
  });

  it("shows permission-specific message for disallowed command", async () => {
    interactionManager.start({
      kind: "permission",
      expectedInput: "callback",
      allowedCommands: ["/status"],
    });

    const ctx = createTextContext("/new");
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("permission.blocked.command_not_allowed"));
  });

  it("shows rename-specific message for disallowed command", async () => {
    interactionManager.start({
      kind: "rename",
      expectedInput: "text",
      allowedCommands: ["/status"],
    });

    const ctx = createTextContext("/new");
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("rename.blocked.command_not_allowed"));
  });

  it("blocks voice input while rename interaction expects text", async () => {
    interactionManager.start({
      kind: "rename",
      expectedInput: "text",
    });

    const ctx = createVoiceContext();
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("rename.blocked.expected_name"));
  });

  it("shows question-specific message for blocked text", async () => {
    interactionManager.start({
      kind: "question",
      expectedInput: "callback",
    });

    const ctx = createTextContext("hello");
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("question.blocked.expected_answer"));
  });

  it("shows question-specific message for disallowed command", async () => {
    interactionManager.start({
      kind: "question",
      expectedInput: "callback",
      allowedCommands: ["/status"],
    });

    const ctx = createTextContext("/new");
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("question.blocked.command_not_allowed"));
  });

  it("allows task cancel callback while text is expected", async () => {
    interactionManager.start({
      kind: "task",
      expectedInput: "text",
    });

    const ctx = createCallbackContext("task:cancel");
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
  });

  it("shows task-specific message for disallowed command", async () => {
    interactionManager.start({
      kind: "task",
      expectedInput: "text",
      allowedCommands: ["/status"],
    });

    const ctx = createTextContext("/new");
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("task.blocked.command_not_allowed"));
  });

  it("blocks disallowed command while busy with generic blocked message", async () => {
    foregroundSessionState.markBusy("session-1");

    const ctx = createTextContext("/new");
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("bot.session_busy"));
  });

  it("blocks plain text while busy with generic blocked message", async () => {
    foregroundSessionState.markBusy("session-1");

    const ctx = createTextContext("hello");
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("bot.session_busy"));
  });

  it("blocks callback while busy without active question or permission", async () => {
    foregroundSessionState.markBusy("session-1");

    const ctx = createCallbackContext("project:123");
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("bot.session_busy"),
    });
  });

  it("allows abort, status, and help while busy", async () => {
    foregroundSessionState.markBusy("session-1");

    for (const command of ["/abort", "/status", "/help"]) {
      const ctx = createTextContext(command);
      const next: NextFunction = vi.fn().mockResolvedValue(undefined);

      await interactionGuardMiddleware(ctx, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(ctx.reply).not.toHaveBeenCalled();
    }
  });

  it("allows active question callback while busy", async () => {
    foregroundSessionState.markBusy("session-1");
    interactionManager.start({
      kind: "question",
      expectedInput: "mixed",
    });

    const ctx = createCallbackContext("question:select:0:1");
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
  });

  it("allows active permission callback while busy", async () => {
    foregroundSessionState.markBusy("session-1");
    interactionManager.start({
      kind: "permission",
      expectedInput: "callback",
    });

    const ctx = createCallbackContext("permission:allow:1");
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
  });

  it("reconciles stale attachManager busy state with OpenCode and allows input when idle", async () => {
    mocked.currentSession = { id: "session-1", title: "Session", directory: "/repo" };
    attachManager.attach("session-1", "/repo");
    attachManager.markBusy("session-1");

    mocked.getActiveSessionsMock.mockResolvedValue({
      data: {},
      error: null,
    });

    const ctx = createTextContext("hello");
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(mocked.getActiveSessionsMock).toHaveBeenCalledTimes(1);
    expect(attachManager.isBusy()).toBe(false);
    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("keeps input blocked when OpenCode confirms the session is running", async () => {
    mocked.currentSession = { id: "session-1", title: "Session", directory: "/repo" };
    attachManager.attach("session-1", "/repo");
    attachManager.markBusy("session-1");

    mocked.getActiveSessionsMock.mockResolvedValue({
      data: { "session-1": { type: "running" } },
      error: null,
    });

    const ctx = createTextContext("hello");
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(mocked.getActiveSessionsMock).toHaveBeenCalledTimes(1);
    expect(attachManager.isBusy()).toBe(true);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("bot.session_busy"));
  });

  it("does not reconcile when attachManager is not busy", async () => {
    mocked.currentSession = { id: "session-1", title: "Session", directory: "/repo" };
    attachManager.attach("session-1", "/repo");

    const ctx = createTextContext("hello");
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(mocked.getActiveSessionsMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not reconcile when there is no current session", async () => {
    attachManager.attach("session-1", "/repo");
    attachManager.markBusy("session-1");

    const ctx = createTextContext("hello");
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await interactionGuardMiddleware(ctx, next);

    expect(mocked.getActiveSessionsMock).not.toHaveBeenCalled();
    expect(attachManager.isBusy()).toBe(true);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("bot.session_busy"));
  });
});
