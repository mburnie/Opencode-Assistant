import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "grammy";

const mocked = vi.hoisted(() => ({
  setCurrentProjectMock: vi.fn(),
  clearSessionMock: vi.fn(),
  summaryAggregatorClearMock: vi.fn(),
  clearAllInteractionStateMock: vi.fn(),
  pinnedClearMock: vi.fn().mockResolvedValue(undefined),
  pinnedRefreshMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/settings/manager.js", () => ({
  setCurrentProject: mocked.setCurrentProjectMock,
}));
vi.mock("../../../src/session/manager.js", () => ({
  clearSession: mocked.clearSessionMock,
}));
vi.mock("../../../src/summary/aggregator.js", () => ({
  summaryAggregator: { clear: mocked.summaryAggregatorClearMock },
}));
vi.mock("../../../src/interaction/cleanup.js", () => ({
  clearAllInteractionState: mocked.clearAllInteractionStateMock,
}));
vi.mock("../../../src/pinned/manager.js", () => ({
  pinnedMessageManager: {
    clear: mocked.pinnedClearMock,
    refreshContextLimit: mocked.pinnedRefreshMock,
  },
}));
vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { switchToProject } from "../../../src/bot/utils/switch-project.js";

function createCtx(chatId: number = 123): Context {
  return {
    chat: { id: chatId },
    api: { sendMessage: vi.fn() },
  } as unknown as Context;
}

const testProject = { id: "proj-1", worktree: "/home/user/my-app", name: "My App" };

describe("switch-project", () => {
  beforeEach(() => {
    mocked.pinnedClearMock.mockReset().mockResolvedValue(undefined);
    mocked.pinnedRefreshMock.mockReset().mockResolvedValue(undefined);
  });

  it("should call state-clearing functions with correct arguments", async () => {
    const ctx = createCtx();
    await switchToProject(ctx, testProject, "test_reason");

    expect(mocked.setCurrentProjectMock).toHaveBeenCalledWith(testProject);
    expect(mocked.clearSessionMock).toHaveBeenCalled();
    expect(mocked.summaryAggregatorClearMock).toHaveBeenCalled();
    expect(mocked.clearAllInteractionStateMock).toHaveBeenCalledWith("test_reason");
  });

  it("should clear pinned message and refresh context limit", async () => {
    const ctx = createCtx();
    await switchToProject(ctx, testProject, "test_reason");

    expect(mocked.pinnedClearMock).toHaveBeenCalled();
    expect(mocked.pinnedRefreshMock).toHaveBeenCalled();
  });

  it("should not throw if pinnedMessageManager.clear rejects", async () => {
    mocked.pinnedClearMock.mockRejectedValue(new Error("unpin failed"));
    const ctx = createCtx();

    await expect(switchToProject(ctx, testProject, "test_reason")).resolves.toBeUndefined();
  });
});
