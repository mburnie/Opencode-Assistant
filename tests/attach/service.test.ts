import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Context } from "grammy";
import {
  attachToSession,
  restoreAttachedCurrentSession,
} from "../../src/attach/service.js";
import { attachManager } from "../../src/attach/manager.js";
import { permissionManager } from "../../src/permission/manager.js";

const mocked = vi.hoisted(() => ({
  currentProject: {
    id: "project-1",
    worktree: "D:\\Projects\\Repo",
  } as { id: string; worktree: string } | null,
  currentSession: {
    id: "session-1",
    title: "Session One",
    directory: "D:\\Projects\\Repo",
  } as { id: string; title: string; directory: string } | null,

  getActiveSessionsMock: vi.fn(),
  listSessionFormsMock: vi.fn(),
  getSessionFormMock: vi.fn(),
  listPendingPermissionsMock: vi.fn(),
  toLegacyPermissionRequestMock: vi.fn((req: any) => req),

  setSessionSummaryMock: vi.fn(),
  setBotAndChatIdMock: vi.fn(),
  pinnedIsInitializedMock: vi.fn(() => true),
  pinnedInitializeMock: vi.fn(),
  pinnedGetStateMock: vi.fn(),
  pinnedOnSessionChangeMock: vi.fn(),
  pinnedRestoreExistingSessionMock: vi.fn(),
  pinnedLoadContextFromHistoryMock: vi.fn(),
  pinnedGetContextInfoMock: vi.fn(() => null),
  pinnedSetAttachStateMock: vi.fn(),

  formManagerActiveMock: vi.fn(() => false),
  handleFormCreatedMock: vi.fn(),
  showCurrentFormFieldMock: vi.fn(),
  showPermissionRequestMock: vi.fn(),
  ensureEventSubscriptionMock: vi.fn(),
}));

vi.mock("../../src/settings/manager.js", () => ({
  getCurrentProject: vi.fn(() => mocked.currentProject),
}));

vi.mock("../../src/session/manager.js", () => ({
  getCurrentSession: vi.fn(() => mocked.currentSession),
}));

vi.mock("../../src/opencode/client-v2.js", () => ({
  getActiveSessions: mocked.getActiveSessionsMock,
  listSessionForms: mocked.listSessionFormsMock,
  getSessionForm: mocked.getSessionFormMock,
  listPendingPermissions: mocked.listPendingPermissionsMock,
  toLegacyPermissionRequest: mocked.toLegacyPermissionRequestMock,
}));

vi.mock("../../src/summary/aggregator.js", () => ({
  summaryAggregator: {
    setSession: mocked.setSessionSummaryMock,
    setBotAndChatId: mocked.setBotAndChatIdMock,
    clear: vi.fn(),
  },
}));

vi.mock("../../src/pinned/manager.js", () => ({
  pinnedMessageManager: {
    isInitialized: mocked.pinnedIsInitializedMock,
    initialize: mocked.pinnedInitializeMock,
    getState: mocked.pinnedGetStateMock,
    onSessionChange: mocked.pinnedOnSessionChangeMock,
    restoreExistingSession: mocked.pinnedRestoreExistingSessionMock,
    loadContextFromHistory: mocked.pinnedLoadContextFromHistoryMock,
    getContextInfo: mocked.pinnedGetContextInfoMock,
    setAttachState: mocked.pinnedSetAttachStateMock,
  },
}));

vi.mock("../../src/form/manager.js", () => ({
  formManager: {
    isActive: mocked.formManagerActiveMock,
  },
}));

vi.mock("../../src/bot/handlers/form.js", () => ({
  handleFormCreated: mocked.handleFormCreatedMock,
  showCurrentFormField: mocked.showCurrentFormFieldMock,
}));

vi.mock("../../src/bot/handlers/permission.js", () => ({
  showPermissionRequest: mocked.showPermissionRequestMock,
}));

function createBot(): Bot<Context> {
  return {
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1001 }),
    },
  } as unknown as Bot<Context>;
}

describe("attach/service", () => {
  beforeEach(() => {
    attachManager.__resetForTests();
    permissionManager.clear();

    mocked.currentProject = {
      id: "project-1",
      worktree: "D:\\Projects\\Repo",
    };
    mocked.currentSession = {
      id: "session-1",
      title: "Session One",
      directory: "D:\\Projects\\Repo",
    };

    mocked.getActiveSessionsMock.mockReset();
    mocked.getActiveSessionsMock.mockResolvedValue({
      data: {
        "session-1": { type: "running" },
      },
      error: null,
    });
    mocked.listSessionFormsMock.mockReset();
    mocked.listSessionFormsMock.mockResolvedValue({ data: [], error: null });
    mocked.getSessionFormMock.mockReset();
    mocked.listPendingPermissionsMock.mockReset();
    mocked.listPendingPermissionsMock.mockResolvedValue({ data: [], error: null });
    mocked.setSessionSummaryMock.mockReset();
    mocked.setBotAndChatIdMock.mockReset();
    mocked.pinnedIsInitializedMock.mockReset();
    mocked.pinnedIsInitializedMock.mockReturnValue(true);
    mocked.pinnedInitializeMock.mockReset();
    mocked.pinnedGetStateMock.mockReset();
    mocked.pinnedGetStateMock.mockImplementation(() => ({
      sessionId: mocked.currentSession?.id ?? null,
      messageId: 123,
    }));
    mocked.pinnedOnSessionChangeMock.mockReset();
    mocked.pinnedOnSessionChangeMock.mockResolvedValue(undefined);
    mocked.pinnedRestoreExistingSessionMock.mockReset();
    mocked.pinnedRestoreExistingSessionMock.mockResolvedValue(undefined);
    mocked.pinnedLoadContextFromHistoryMock.mockReset();
    mocked.pinnedLoadContextFromHistoryMock.mockResolvedValue(undefined);
    mocked.pinnedGetContextInfoMock.mockReset();
    mocked.pinnedGetContextInfoMock.mockReturnValue(null);
    mocked.pinnedSetAttachStateMock.mockReset();
    mocked.pinnedSetAttachStateMock.mockResolvedValue(undefined);

    mocked.formManagerActiveMock.mockReset();
    mocked.formManagerActiveMock.mockReturnValue(false);
    mocked.handleFormCreatedMock.mockReset();
    mocked.showCurrentFormFieldMock.mockReset();
    mocked.showPermissionRequestMock.mockReset();
    mocked.ensureEventSubscriptionMock.mockReset();
    mocked.ensureEventSubscriptionMock.mockResolvedValue(undefined);
  });

  it("follows an idle session and updates attach state", async () => {
    mocked.getActiveSessionsMock.mockResolvedValueOnce({
      data: { "session-1": { type: "idle" } },
      error: null,
    });

    const result = await attachToSession({
      bot: createBot(),
      chatId: 777,
      session: mocked.currentSession!,
      ensureEventSubscription: mocked.ensureEventSubscriptionMock,
    });

    expect(result).toEqual({
      busy: false,
      alreadyAttached: false,
      restoredForm: false,
      restoredPermissions: 0,
    });
    expect(mocked.ensureEventSubscriptionMock).toHaveBeenCalledWith("D:\\Projects\\Repo");
    expect(mocked.setSessionSummaryMock).toHaveBeenCalledWith("session-1");
    expect(mocked.setBotAndChatIdMock).toHaveBeenCalled();
    expect(mocked.pinnedSetAttachStateMock).toHaveBeenCalledWith(true, false);
    expect(attachManager.getSnapshot()).toMatchObject({
      sessionId: "session-1",
      directory: "D:\\Projects\\Repo",
      busy: false,
    });
  });

  it("does not resubscribe when already following the same session", async () => {
    const bot = createBot();

    await attachToSession({
      bot,
      chatId: 777,
      session: mocked.currentSession!,
      ensureEventSubscription: mocked.ensureEventSubscriptionMock,
    });

    const result = await attachToSession({
      bot,
      chatId: 777,
      session: mocked.currentSession!,
      ensureEventSubscription: mocked.ensureEventSubscriptionMock,
    });

    expect(result.alreadyAttached).toBe(true);
    expect(mocked.ensureEventSubscriptionMock).toHaveBeenCalledTimes(1);
  });

  it("restores a pending form when first following a session", async () => {
    mocked.listSessionFormsMock.mockResolvedValueOnce({
      data: [{ id: "form-1", sessionID: "session-1", title: "Test", fields: [] }],
      error: null,
    });
    mocked.getSessionFormMock.mockResolvedValueOnce({
      data: {
        id: "form-1",
        sessionID: "session-1",
        title: "Test",
        fields: [],
        state: { status: "pending" },
      },
      error: null,
    });

    const result = await attachToSession({
      bot: createBot(),
      chatId: 777,
      session: mocked.currentSession!,
      ensureEventSubscription: mocked.ensureEventSubscriptionMock,
    });

    expect(result.restoredForm).toBe(true);
    expect(mocked.handleFormCreatedMock).toHaveBeenCalledOnce();
    expect(mocked.showCurrentFormFieldMock).toHaveBeenCalledOnce();
  });

  it("restores the saved current session on startup", async () => {
    const restored = await restoreAttachedCurrentSession({
      bot: createBot(),
      chatId: 777,
      ensureEventSubscription: mocked.ensureEventSubscriptionMock,
    });

    expect(restored).toBe(true);
    expect(mocked.ensureEventSubscriptionMock).toHaveBeenCalledWith("D:\\Projects\\Repo");
    expect(attachManager.getSnapshot()?.sessionId).toBe("session-1");
  });

  it("reuses a saved pinned message after restart instead of recreating it", async () => {
    mocked.pinnedGetStateMock.mockReturnValueOnce({
      sessionId: null,
      messageId: 123,
    });

    const restored = await restoreAttachedCurrentSession({
      bot: createBot(),
      chatId: 777,
      ensureEventSubscription: mocked.ensureEventSubscriptionMock,
    });

    expect(restored).toBe(true);
    expect(mocked.pinnedRestoreExistingSessionMock).toHaveBeenCalledWith(
      "session-1",
      "Session One",
    );
    expect(mocked.pinnedOnSessionChangeMock).not.toHaveBeenCalled();
    expect(mocked.pinnedLoadContextFromHistoryMock).toHaveBeenCalledWith(
      "session-1",
      "D:\\Projects\\Repo",
    );
  });

  it("skips startup restore when stored project and session do not match", async () => {
    mocked.currentProject = {
      id: "project-1",
      worktree: "D:\\Projects\\Other",
    };

    const restored = await restoreAttachedCurrentSession({
      bot: createBot(),
      chatId: 777,
      ensureEventSubscription: mocked.ensureEventSubscriptionMock,
    });

    expect(restored).toBe(false);
    expect(mocked.ensureEventSubscriptionMock).not.toHaveBeenCalled();
    expect(attachManager.getSnapshot()).toBeNull();
  });
});
