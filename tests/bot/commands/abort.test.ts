import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { abortCommand, abortCurrentOperation } from "../../../src/bot/commands/abort.js";
import { clearAllInteractionState } from "../../../src/interaction/cleanup.js";
import { formManager } from "../../../src/form/manager.js";
import { permissionManager } from "../../../src/permission/manager.js";
import { renameManager } from "../../../src/rename/manager.js";
import { interactionManager } from "../../../src/interaction/manager.js";
import { attachManager } from "../../../src/attach/manager.js";
import type { FormInfo } from "@opencode/client/promise";
import { resolveInteractionGuardDecision } from "../../../src/interaction/guard.js";
import type { PermissionRequest } from "../../../src/permission/types.js";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  currentSession: null as { id: string; title: string; directory: string } | null,
  abortMock: vi.fn(),
  statusMock: vi.fn(),
  listFormsMock: vi.fn(),
  getFormMock: vi.fn(),
  cancelFormMock: vi.fn(),
}));

vi.mock("../../../src/session/manager.js", () => ({
  getCurrentSession: vi.fn(() => mocked.currentSession),
}));

vi.mock("../../../src/opencode/client-v2.js", () => ({
  getActiveSessions: mocked.statusMock,
  interruptSession: mocked.abortMock,
  listSessionForms: mocked.listFormsMock,
  getSessionForm: mocked.getFormMock,
  cancelForm: mocked.cancelFormMock,
}));

const TEST_FORM = {
  id: "form-1",
  sessionID: "session-1",
  title: "Pick one",
  fields: [{ key: "choice", type: "string", title: "Choice" }],
} as unknown as FormInfo;

const TEST_PERMISSION: PermissionRequest = {
  id: "perm-1",
  sessionID: "session-1",
  permission: "bash",
  patterns: ["npm test"],
  metadata: {},
  always: [],
};

function activateInteractionState(): void {
  formManager.startForm(TEST_FORM);
  permissionManager.startPermission(TEST_PERMISSION, 101);
  renameManager.startWaiting("session-1", "D:/repo", "Old title");
  interactionManager.start({
    kind: "rename",
    expectedInput: "text",
    metadata: { sessionId: "session-1" },
  });
}

describe("bot/commands/abort", () => {
  beforeEach(() => {
    clearAllInteractionState("test_setup");
    attachManager.__resetForTests();
    mocked.currentSession = null;
    mocked.abortMock.mockReset();
    mocked.statusMock.mockReset();
    mocked.listFormsMock.mockReset();
    mocked.getFormMock.mockReset();
    mocked.cancelFormMock.mockReset();
    mocked.listFormsMock.mockResolvedValue({ data: [] });
    mocked.cancelFormMock.mockResolvedValue({});
  });

  it("clears interaction state even when there is no active session", async () => {
    activateInteractionState();

    const replyMock = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      reply: replyMock,
    } as unknown as Context;

    await abortCommand(ctx as never);

    expect(replyMock).toHaveBeenCalledWith(t("stop.no_active_session"));
    expect(formManager.isActive()).toBe(false);
    expect(permissionManager.isActive()).toBe(false);
    expect(renameManager.isWaitingForName()).toBe(false);
    expect(interactionManager.getSnapshot()).toBeNull();
    expect(mocked.abortMock).not.toHaveBeenCalled();
  });

  it("clears interaction state and aborts active session", async () => {
    activateInteractionState();

    mocked.currentSession = {
      id: "session-1",
      title: "Session",
      directory: "D:/repo",
    };

    mocked.abortMock.mockResolvedValue({ data: true, error: null });
    mocked.statusMock.mockResolvedValue({
      data: {
        "session-1": { type: "idle" },
      },
      error: null,
    });

    const replyMock = vi.fn().mockResolvedValue({ message_id: 88 });
    const editMessageTextMock = vi.fn().mockResolvedValue(undefined);

    const ctx = {
      chat: { id: 777 },
      reply: replyMock,
      api: {
        editMessageText: editMessageTextMock,
      },
    } as unknown as Context;

    await abortCommand(ctx as never);

    expect(replyMock).toHaveBeenCalledWith(t("stop.in_progress"));
    expect(mocked.abortMock).toHaveBeenCalled();
    expect(editMessageTextMock).toHaveBeenCalledWith(777, 88, t("stop.success"));

    expect(formManager.isActive()).toBe(false);
    expect(permissionManager.isActive()).toBe(false);
    expect(renameManager.isWaitingForName()).toBe(false);
    expect(interactionManager.getSnapshot()).toBeNull();
  });

  it("can abort silently without progress messages", async () => {
    activateInteractionState();

    mocked.currentSession = {
      id: "session-1",
      title: "Session",
      directory: "D:/repo",
    };

    mocked.abortMock.mockResolvedValue({ data: true, error: null });
    mocked.statusMock.mockResolvedValue({
      data: {
        "session-1": { type: "idle" },
      },
      error: null,
    });

    const replyMock = vi.fn().mockResolvedValue({ message_id: 88 });
    const editMessageTextMock = vi.fn().mockResolvedValue(undefined);

    const ctx = {
      chat: { id: 777 },
      reply: replyMock,
      api: {
        editMessageText: editMessageTextMock,
      },
    } as unknown as Context;

    await abortCurrentOperation(ctx as never, { notifyUser: false });

    expect(mocked.abortMock).toHaveBeenCalled();
    expect(replyMock).not.toHaveBeenCalled();
    expect(editMessageTextMock).not.toHaveBeenCalled();

    expect(formManager.isActive()).toBe(false);
    expect(permissionManager.isActive()).toBe(false);
    expect(renameManager.isWaitingForName()).toBe(false);
    expect(interactionManager.getSnapshot()).toBeNull();
  });

  it("clears the attached session busy flag after successful abort", async () => {
    mocked.currentSession = {
      id: "session-1",
      title: "Session",
      directory: "D:/repo",
    };

    attachManager.attach("session-1", "D:/repo");
    attachManager.markBusy("session-1");

    mocked.abortMock.mockResolvedValue({ data: true, error: null });
    mocked.statusMock.mockResolvedValue({
      data: {
        "session-1": { type: "idle" },
      },
      error: null,
    });

    const ctx = {
      chat: { id: 777 },
      reply: vi.fn().mockResolvedValue({ message_id: 88 }),
      api: {
        editMessageText: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as Context;

    await abortCommand(ctx as never);

    expect(attachManager.isBusy()).toBe(false);
  });

  describe("v2 form cleanup", () => {
    function activateForm(): void {
      formManager.startForm(TEST_FORM);
      interactionManager.start({
        kind: "form",
        expectedInput: "callback",
        metadata: { sessionId: "session-1" },
      });
    }

    function makeCtx() {
      const editMessageTextMock = vi.fn().mockResolvedValue(undefined);
      const replyMock = vi.fn().mockResolvedValue({ message_id: 88 });
      const ctx = {
        chat: { id: 777 },
        reply: replyMock,
        api: { editMessageText: editMessageTextMock },
      } as unknown as Context;
      return { ctx, replyMock, editMessageTextMock };
    }

    function textMessageCtx(text: string): Context {
      return { message: { text } } as unknown as Context;
    }

    function useIdleActiveSession(): void {
      mocked.currentSession = { id: "session-1", title: "Session", directory: "D:/repo" };
      mocked.abortMock.mockResolvedValue({ data: true, error: null });
      mocked.statusMock.mockResolvedValue({ data: {}, error: null });
    }

    it("cancels the active form and other pending server forms, then accepts ordinary text", async () => {
      activateForm();
      useIdleActiveSession();
      mocked.listFormsMock.mockResolvedValue({
        data: [{ id: "form-1" }, { id: "form-2" }, { id: "form-3" }],
      });
      mocked.getFormMock.mockImplementation(async (_sessionId: string, formId: string) => ({
        data: { id: formId, state: { status: formId === "form-3" ? "answered" : "pending" } },
      }));

      expect(resolveInteractionGuardDecision(textMessageCtx("hello")).allow).toBe(false);

      const { ctx, editMessageTextMock } = makeCtx();
      await abortCommand(ctx as never);

      expect(mocked.cancelFormMock).toHaveBeenCalledTimes(2);
      expect(mocked.cancelFormMock).toHaveBeenCalledWith("session-1", "form-1");
      expect(mocked.cancelFormMock).toHaveBeenCalledWith("session-1", "form-2");
      expect(mocked.cancelFormMock).not.toHaveBeenCalledWith("session-1", "form-3");
      expect(editMessageTextMock).toHaveBeenCalledWith(777, 88, t("stop.success"));
      expect(formManager.isActive()).toBe(false);
      expect(interactionManager.getSnapshot()).toBeNull();
      expect(resolveInteractionGuardDecision(textMessageCtx("hello")).allow).toBe(true);
    });

    it("clears a form that re-activates while the interrupt is in flight", async () => {
      useIdleActiveSession();
      mocked.abortMock.mockImplementation(async () => {
        activateForm();
        return { data: true, error: null };
      });
      mocked.listFormsMock.mockResolvedValue({ data: [{ id: "form-1" }] });
      mocked.getFormMock.mockResolvedValue({ data: { id: "form-1", state: { status: "pending" } } });

      const { ctx } = makeCtx();
      await abortCommand(ctx as never);

      expect(mocked.cancelFormMock).toHaveBeenCalledWith("session-1", "form-1");
      expect(formManager.isActive()).toBe(false);
      expect(interactionManager.getSnapshot()).toBeNull();
      expect(resolveInteractionGuardDecision(textMessageCtx("hello")).allow).toBe(true);
    });

    it("cancels the active form even when there is no current session", async () => {
      activateForm();

      const { ctx, replyMock } = makeCtx();
      await abortCommand(ctx as never);

      expect(replyMock).toHaveBeenCalledWith(t("stop.no_active_session"));
      expect(mocked.cancelFormMock).toHaveBeenCalledWith("session-1", "form-1");
      expect(formManager.isActive()).toBe(false);
      expect(interactionManager.getSnapshot()).toBeNull();
    });

    it("still completes the abort when listing or cancelling forms fails", async () => {
      activateForm();
      useIdleActiveSession();
      mocked.listFormsMock.mockRejectedValue(new Error("network down"));
      mocked.cancelFormMock.mockResolvedValue({ error: new Error("already answered") });

      const { ctx, editMessageTextMock } = makeCtx();
      await abortCommand(ctx as never);

      expect(editMessageTextMock).toHaveBeenCalledWith(777, 88, t("stop.success"));
      expect(formManager.isActive()).toBe(false);
      expect(interactionManager.getSnapshot()).toBeNull();
      expect(resolveInteractionGuardDecision(textMessageCtx("hello")).allow).toBe(true);
    });

    it("clears local form state even when the interrupt request throws", async () => {
      activateForm();
      mocked.currentSession = { id: "session-1", title: "Session", directory: "D:/repo" };
      mocked.abortMock.mockRejectedValue(new Error("server unreachable"));

      const { ctx, editMessageTextMock } = makeCtx();
      await abortCommand(ctx as never);

      expect(editMessageTextMock).toHaveBeenCalledWith(777, 88, t("stop.warn_local_only"));
      expect(mocked.cancelFormMock).toHaveBeenCalledWith("session-1", "form-1");
      expect(formManager.isActive()).toBe(false);
      expect(interactionManager.getSnapshot()).toBeNull();
    });
  });
});
