import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Context } from "grammy";
import { processUserPrompt, type ProcessPromptDeps } from "../../../src/bot/handlers/prompt.js";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  currentProject: { id: "project-1", worktree: "D:\\Projects\\Repo" },
  currentSession: {
    id: "session-1",
    title: "Session",
    directory: "D:\\Projects\\Repo",
  } as { id: string; title: string; directory: string } | null,
  sessionStatusMock: vi.fn(),
  sessionPromptAsyncMock: vi.fn(),
  sessionCreateMock: vi.fn(),
  suppressionRegisterMock: vi.fn(),
  safeBackgroundTaskMock: vi.fn(),
  setSessionSummaryMock: vi.fn(),
  setBotAndChatIdMock: vi.fn(),
  attachToSessionMock: vi.fn(),
  isFreeModelMock: vi.fn(),
}));

vi.mock("../../../src/opencode/client-v2.js", () => ({
  getActiveSessions: mocked.sessionStatusMock,
  promptSession: mocked.sessionPromptAsyncMock,
  createSession: mocked.sessionCreateMock,
}));

vi.mock("../../../src/session/manager.js", () => ({
  getCurrentSession: vi.fn(() => mocked.currentSession),
  setCurrentSession: vi.fn(),
  clearSession: vi.fn(),
}));

vi.mock("../../../src/session/cache-manager.js", () => ({
  ingestSessionInfoForCache: vi.fn(),
  __resetSessionDirectoryCacheForTests: vi.fn(),
}));

vi.mock("../../../src/settings/manager.js", () => ({
  getCurrentProject: vi.fn(() => mocked.currentProject),
  isTtsEnabled: vi.fn(() => false),
}));

vi.mock("../../../src/agent/manager.js", () => ({
  getStoredAgent: vi.fn(() => "build"),
  resolveProjectAgent: vi.fn(async (agentName?: string) => agentName ?? "build"),
}));

vi.mock("../../../src/model/manager.js", () => ({
  getStoredModel: vi.fn(() => ({
    providerID: "openai",
    modelID: "gpt-5",
    variant: "default",
  })),
  isFreeModel: mocked.isFreeModelMock,
}));

vi.mock("../../../src/pinned/manager.js", () => ({
  pinnedMessageManager: {
    isInitialized: vi.fn(() => true),
    initialize: vi.fn(),
    getState: vi.fn(() => ({ messageId: 1 })),
    onSessionChange: vi.fn(),
    clear: vi.fn(),
    getContextInfo: vi.fn(() => null),
  },
}));

vi.mock("../../../src/summary/aggregator.js", () => ({
  summaryAggregator: {
    setSession: mocked.setSessionSummaryMock,
    setBotAndChatId: mocked.setBotAndChatIdMock,
    clear: vi.fn(),
  },
}));

vi.mock("../../../src/interaction/manager.js", () => ({
  interactionManager: {
    clear: vi.fn(),
    getSnapshot: vi.fn(() => null),
  },
}));

vi.mock("../../../src/interaction/cleanup.js", () => ({
  clearAllInteractionState: vi.fn(),
}));

vi.mock("../../../src/utils/safe-background-task.js", () => ({
  safeBackgroundTask: vi.fn((options) => {
    mocked.safeBackgroundTaskMock(options);
  }),
}));

vi.mock("../../../src/utils/error-format.js", () => ({
  formatErrorDetails: vi.fn(() => "formatted error"),
}));

vi.mock("../../../src/memory/injector.js", () => ({
  injectMemoryIntoPrompt: vi.fn(async (text: string) => text),
}));

vi.mock("../../../src/scheduled-task/foreground-state.js", () => ({
  foregroundSessionState: {
    markBusy: vi.fn(),
    markIdle: vi.fn(),
    clearAll: vi.fn(),
  },
}));

vi.mock("../../../src/bot/assistant-run-state.js", () => ({
  assistantRunState: {
    startRun: vi.fn(),
    clearRun: vi.fn(),
    clearAll: vi.fn(),
  },
}));

vi.mock("../../../src/attach/service.js", () => ({
  attachToSession: mocked.attachToSessionMock,
  detachAttachedSession: vi.fn(),
  markAttachedSessionBusy: vi.fn().mockResolvedValue(undefined),
  markAttachedSessionIdle: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/external-input/suppression.js", () => ({
  externalUserInputSuppressionManager: {
    register: mocked.suppressionRegisterMock,
  },
}));

vi.mock("../../../src/memory/injector.js", () => ({
  injectMemoryIntoPrompt: vi.fn(async (text: string) => text),
}));

function createContext(): Context {
  return {
    chat: { id: 777 },
    reply: vi.fn().mockResolvedValue({ message_id: 100 }),
  } as unknown as Context;
}

function createDeps(): ProcessPromptDeps {
  return {
    bot: { api: { sendMessage: vi.fn().mockResolvedValue(undefined) } } as unknown as Bot<Context>,
    ensureEventSubscription: vi.fn().mockResolvedValue(undefined),
  };
}

function getScheduledBackgroundTask(): {
  task: () => Promise<unknown>;
  onSuccess?: (value: { error: unknown | null }) => void;
  onError?: (error: unknown) => void;
} {
  const [[options]] = mocked.safeBackgroundTaskMock.mock.calls as [[{
    task: () => Promise<unknown>;
    onSuccess?: (value: { error: unknown | null }) => void;
    onError?: (error: unknown) => void;
  }]];

  return options;
}

describe("bot/handlers/prompt", () => {
  beforeEach(() => {
    mocked.currentProject = { id: "project-1", worktree: "D:\\Projects\\Repo" };
    mocked.currentSession = {
      id: "session-1",
      title: "Session",
      directory: "D:\\Projects\\Repo",
    };
    mocked.sessionStatusMock.mockReset();
    mocked.sessionPromptAsyncMock.mockReset();
    mocked.sessionCreateMock.mockReset();
    mocked.suppressionRegisterMock.mockReset();
    mocked.safeBackgroundTaskMock.mockReset();
    mocked.setSessionSummaryMock.mockReset();
    mocked.setBotAndChatIdMock.mockReset();
    mocked.attachToSessionMock.mockReset();
    mocked.isFreeModelMock.mockReset();
    mocked.isFreeModelMock.mockResolvedValue(false);
    mocked.attachToSessionMock.mockResolvedValue({
      busy: false,
      alreadyAttached: false,
      restoredForm: false,
      restoredPermissions: 0,
    });

    mocked.sessionStatusMock.mockResolvedValue({
      data: {
        "session-1": { type: "idle" },
      },
      error: null,
    });
    mocked.sessionPromptAsyncMock.mockResolvedValue({ data: {}, error: null });
  });

  it("registers suppression entry for text prompts", async () => {
    const handled = await processUserPrompt(createContext(), "Review README", createDeps());

    expect(handled).toBe(true);
    expect(mocked.attachToSessionMock).toHaveBeenCalledWith({
      bot: expect.any(Object),
      chatId: 777,
      session: {
        id: "session-1",
        title: "Session",
        directory: "D:\\Projects\\Repo",
      },
      ensureEventSubscription: expect.any(Function),
    });
    expect(mocked.suppressionRegisterMock).toHaveBeenCalledWith("session-1", "Review README");
  });

  it("starts prompts through promptAsync instead of the streaming prompt endpoint", async () => {
    const handled = await processUserPrompt(createContext(), "Review README", createDeps());

    expect(handled).toBe(true);

    const backgroundTask = getScheduledBackgroundTask();
    await backgroundTask.task();

    expect(mocked.sessionPromptAsyncMock).toHaveBeenCalledWith({
      sessionID: "session-1",
      text: "Review README",
      files: [],
      agent: "build",
      model: {
        providerID: "openai",
        modelID: "gpt-5",
        variant: "default",
      },
    });
  });

  it("appends the approval-scope instruction when a free model is selected", async () => {
    mocked.isFreeModelMock.mockResolvedValue(true);

    const handled = await processUserPrompt(createContext(), "Review README", createDeps());

    expect(handled).toBe(true);

    const backgroundTask = getScheduledBackgroundTask();
    await backgroundTask.task();

    expect(mocked.isFreeModelMock).toHaveBeenCalledWith("openai", "gpt-5");
    const [promptArgs] = mocked.sessionPromptAsyncMock.mock.calls[0] as [{
      sessionID: string;
      text: string;
      files: unknown[];
    }];
    expect(promptArgs.text).toContain("Review README");
    expect(promptArgs.text).toContain("SECURITY CONSTRAINT (free-plan session)");
  });

  it("does not append the approval-scope instruction for paid models", async () => {
    mocked.isFreeModelMock.mockResolvedValue(false);

    const handled = await processUserPrompt(createContext(), "Review README", createDeps());

    expect(handled).toBe(true);

    const backgroundTask = getScheduledBackgroundTask();
    await backgroundTask.task();

    const [promptArgs] = mocked.sessionPromptAsyncMock.mock.calls[0] as [{
      sessionID: string;
      text: string;
      files: unknown[];
    }];
    expect(promptArgs.text).toBe("Review README");
    expect(promptArgs.text).not.toContain("SECURITY CONSTRAINT");
  });

  it("still notifies the user when promptAsync reports a real start error", async () => {
    const ctx = createContext();
    const deps = createDeps();

    const handled = await processUserPrompt(ctx, "Review README", deps);

    expect(handled).toBe(true);

    const backgroundTask = getScheduledBackgroundTask();
    backgroundTask.onSuccess?.({ error: new Error("request start failed") });

    expect(deps.bot.api.sendMessage).toHaveBeenCalledWith(
      777,
      t("bot.prompt_send_error"),
    );
  });

  it("still notifies the user when promptAsync rejects before the run starts", async () => {
    const ctx = createContext();
    const deps = createDeps();

    const handled = await processUserPrompt(ctx, "Review README", deps);

    expect(handled).toBe(true);

    const backgroundTask = getScheduledBackgroundTask();
    const startError = new Error("network down");
    mocked.sessionPromptAsyncMock.mockRejectedValueOnce(startError);

    await backgroundTask.task().catch((error) => {
      backgroundTask.onError?.(error);
    });

    expect(deps.bot.api.sendMessage).toHaveBeenCalledWith(
      777,
      t("bot.prompt_send_error"),
    );
  });

  it("does not register suppression entry for file-only prompts", async () => {
    const handled = await processUserPrompt(createContext(), "", createDeps(), [
      {
        type: "file",
        mime: "text/plain",
        url: "data:text/plain;base64,SGVsbG8=",
      } as never,
    ]);

    expect(handled).toBe(true);
    expect(mocked.suppressionRegisterMock).not.toHaveBeenCalled();
  });
});
