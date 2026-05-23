import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { startCommand } from "../../../src/bot/commands/start.js";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  abortCurrentOperationMock: vi.fn(),
  clearSessionMock: vi.fn(),
  clearProjectMock: vi.fn(),
  getStoredAgentMock: vi.fn(() => "build"),
  getStoredModelMock: vi.fn(() => ({
    providerID: "openai",
    modelID: "gpt-5",
    variant: "default",
  })),
  formatVariantForButtonMock: vi.fn(() => "Default"),
  pinnedIsInitializedMock: vi.fn(() => false),
  pinnedInitializeMock: vi.fn(),
  pinnedGetContextLimitMock: vi.fn(() => 0),
  pinnedRefreshContextLimitMock: vi.fn().mockResolvedValue(undefined),
  pinnedGetContextInfoMock: vi.fn(() => null),
  pinnedClearMock: vi.fn().mockResolvedValue(undefined),

}));

vi.mock("../../../src/bot/commands/abort.js", () => ({
  abortCurrentOperation: mocked.abortCurrentOperationMock,
}));

vi.mock("../../../src/session/manager.js", () => ({
  clearSession: mocked.clearSessionMock,
}));

vi.mock("../../../src/settings/manager.js", () => ({
  clearProject: mocked.clearProjectMock,
}));

vi.mock("../../../src/agent/manager.js", () => ({
  getStoredAgent: mocked.getStoredAgentMock,
}));

vi.mock("../../../src/model/manager.js", () => ({
  getStoredModel: mocked.getStoredModelMock,
}));

vi.mock("../../../src/variant/manager.js", () => ({
  formatVariantForButton: mocked.formatVariantForButtonMock,
}));

vi.mock("../../../src/pinned/manager.js", () => ({
  pinnedMessageManager: {
    isInitialized: mocked.pinnedIsInitializedMock,
    initialize: mocked.pinnedInitializeMock,
    getContextLimit: mocked.pinnedGetContextLimitMock,
    refreshContextLimit: mocked.pinnedRefreshContextLimitMock,
    getContextInfo: mocked.pinnedGetContextInfoMock,
    clear: mocked.pinnedClearMock,
  },
}));

function createStartContext(): Context {
  return {
    chat: { id: 100 },
    api: {},
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
  } as unknown as Context;
}

describe("bot/commands/start", () => {
  beforeEach(() => {
    mocked.abortCurrentOperationMock.mockReset();
    mocked.abortCurrentOperationMock.mockResolvedValue(undefined);

    mocked.clearSessionMock.mockReset();
    mocked.clearProjectMock.mockReset();

    mocked.getStoredAgentMock.mockReset();
    mocked.getStoredAgentMock.mockReturnValue("build");

    mocked.getStoredModelMock.mockReset();
    mocked.getStoredModelMock.mockReturnValue({
      providerID: "openai",
      modelID: "gpt-5",
      variant: "default",
    });

    mocked.formatVariantForButtonMock.mockReset();
    mocked.formatVariantForButtonMock.mockReturnValue("Default");

    mocked.pinnedIsInitializedMock.mockReset();
    mocked.pinnedIsInitializedMock.mockReturnValue(false);
    mocked.pinnedInitializeMock.mockReset();
    mocked.pinnedGetContextLimitMock.mockReset();
    mocked.pinnedGetContextLimitMock.mockReturnValue(0);
    mocked.pinnedRefreshContextLimitMock.mockReset();
    mocked.pinnedRefreshContextLimitMock.mockResolvedValue(undefined);
    mocked.pinnedGetContextInfoMock.mockReset();
    mocked.pinnedGetContextInfoMock.mockReturnValue(null);
    mocked.pinnedClearMock.mockReset();
    mocked.pinnedClearMock.mockResolvedValue(undefined);

  });

  it("stops active flow, resets project/session, and sends welcome message", async () => {
    const ctx = createStartContext();

    await startCommand(ctx);

    expect(mocked.abortCurrentOperationMock).toHaveBeenCalledWith(ctx, { notifyUser: false });
    expect(mocked.clearSessionMock).toHaveBeenCalledTimes(1);
    expect(mocked.clearProjectMock).toHaveBeenCalledTimes(1);
    expect(mocked.pinnedClearMock).toHaveBeenCalledTimes(1);

    expect(mocked.pinnedInitializeMock).toHaveBeenCalledWith(ctx.api, 100);
    expect(mocked.pinnedRefreshContextLimitMock).toHaveBeenCalledTimes(1);

    expect(ctx.reply).toHaveBeenCalledWith(t("start.welcome"));
  });
});
