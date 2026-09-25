import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  messageListMock: vi.fn(),
  config: {
    opencode: {
      apiUrl: "http://localhost:4096",
      username: "opencode",
      password: "secret",
    },
  },
}));

vi.mock("../../src/config.js", () => ({
  config: mocked.config,
}));

vi.mock("@opencode/client/promise", () => ({
  OpenCode: {
    make: vi.fn(() => ({
      message: {
        list: mocked.messageListMock,
      },
    })),
  },
}));

import { toLegacyMessage, listMessages } from "../../src/opencode/client-v2-messages.js";

describe("opencode/client-v2-messages", () => {
  beforeEach(() => {
    mocked.messageListMock.mockReset();
  });

  it("converts user message to legacy shape", () => {
    const message = {
      id: "m1",
      type: "user" as const,
      time: { created: 1000 },
      text: "hello",
    };

    const legacy = toLegacyMessage(message);

    expect(legacy.info.role).toBe("user");
    expect(legacy.parts).toEqual([{ type: "text", text: "hello" }]);
  });

  it("converts assistant message to legacy shape", () => {
    const message = {
      id: "m2",
      type: "assistant" as const,
      time: { created: 1000 },
      agent: "build",
      model: { id: "gpt-4o", providerID: "openai" },
      content: [{ type: "text" as const, text: "hi there" }],
      cost: 0.001,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 2, write: 0 } },
    };

    const legacy = toLegacyMessage(message);

    expect(legacy.info.role).toBe("assistant");
    expect(legacy.info.agent).toBe("build");
    expect(legacy.info.cost).toBe(0.001);
    expect(legacy.info.tokens).toEqual({ input: 10, cache: { read: 2 } });
    expect(legacy.parts).toEqual([{ type: "text", text: "hi there" }]);
  });

  it("converts compaction message to assistant summary", () => {
    const message = {
      id: "m3",
      type: "compaction" as const,
      time: { created: 1000 },
      status: "running" as const,
      reason: "auto" as const,
      summary: "summary text",
      recent: "recent text",
    };

    const legacy = toLegacyMessage(message);

    expect(legacy.info.role).toBe("assistant");
    expect(legacy.info.summary).toBe(true);
    expect(legacy.parts).toEqual([]);
  });

  it("lists messages", async () => {
    mocked.messageListMock.mockResolvedValue({
      data: [
        {
          id: "m1",
          type: "user" as const,
          time: { created: 1000 },
          text: "hello",
        },
      ],
      cursor: {},
    });

    const result = await listMessages({ sessionID: "s1", limit: 5 });

    expect(mocked.messageListMock).toHaveBeenCalledWith({ sessionID: "s1", limit: 5 });
    expect(result.data).toHaveLength(1);
    expect(result.data?.[0].info.role).toBe("user");
  });
});
