import { beforeEach, describe, expect, it, vi } from "vitest";
import type { V2Event } from "@opencode/client/promise";
import { summaryAggregator } from "../../src/summary/aggregator.js";

const mocked = vi.hoisted(() => ({
  getCurrentProjectMock: vi.fn(),
}));

vi.mock("../../src/settings/manager.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/settings/manager.js")>(
    "../../src/settings/manager.js",
  );

  return {
    ...actual,
    getCurrentProject: mocked.getCurrentProjectMock,
  };
});

const SESSION_ID = "sess_1";

function makeEvent(type: string, data: Record<string, unknown>): V2Event {
  return {
    id: `evt-${Math.random()}`,
    created: Date.now(),
    type,
    data,
  } as unknown as V2Event;
}

function emitAssistantText(messageId: string, text: string): void {
  summaryAggregator.processEvent(
    makeEvent("session.text.started", {
      sessionID: SESSION_ID,
      assistantMessageID: messageId,
      ordinal: 0,
    }),
  );
  summaryAggregator.processEvent(
    makeEvent("session.text.ended", {
      sessionID: SESSION_ID,
      assistantMessageID: messageId,
      ordinal: 0,
      text,
    }),
  );
}

function emitTerminal(
  type:
    | "session.idle"
    | "session.execution.succeeded"
    | "session.execution.failed"
    | "session.execution.interrupted",
): void {
  const data: Record<string, unknown> = { sessionID: SESSION_ID };
  if (type === "session.execution.failed") {
    data.error = { message: "boom" };
  }
  summaryAggregator.processEvent(makeEvent(type, data));
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("summary/aggregator turn completion", () => {
  const onComplete = vi.fn();
  const onSessionIdle = vi.fn();
  const onSessionError = vi.fn();
  const onPartial = vi.fn();

  beforeEach(() => {
    mocked.getCurrentProjectMock.mockReset();
    mocked.getCurrentProjectMock.mockReturnValue({ id: "p1", worktree: "/repo", name: "repo" });
    summaryAggregator.clear();
    summaryAggregator.setOnCleared(() => {});
    summaryAggregator.setTypingIndicatorEnabled(false);
    onComplete.mockReset();
    onSessionIdle.mockReset();
    onSessionError.mockReset();
    onPartial.mockReset();
    summaryAggregator.setOnComplete(onComplete);
    summaryAggregator.setOnSessionIdle(onSessionIdle);
    summaryAggregator.setOnSessionError(onSessionError);
    summaryAggregator.setOnPartial(onPartial);
    summaryAggregator.setSession(SESSION_ID);
  });

  it("finalises a turn once on session.execution.succeeded", async () => {
    emitAssistantText("msg_1", "Hello there");
    emitTerminal("session.execution.succeeded");
    await flushAsync();

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(SESSION_ID, "msg_1", "Hello there", {});
    expect(onSessionIdle).toHaveBeenCalledTimes(1);
    expect(onSessionIdle).toHaveBeenCalledWith(SESSION_ID);
    expect(onSessionError).not.toHaveBeenCalled();
  });

  it("does not finalise twice when session.idle follows session.execution.succeeded", async () => {
    emitAssistantText("msg_1", "Hello there");
    emitTerminal("session.execution.succeeded");
    emitTerminal("session.idle");
    await flushAsync();

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onSessionIdle).toHaveBeenCalledTimes(1);
  });

  it("does not finalise twice when session.execution.succeeded follows session.idle", async () => {
    emitAssistantText("msg_1", "Hello there");
    emitTerminal("session.idle");
    emitTerminal("session.execution.succeeded");
    await flushAsync();

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onSessionIdle).toHaveBeenCalledTimes(1);
  });

  it("keeps session.idle as a fallback across consecutive turns", async () => {
    emitAssistantText("msg_1", "First");
    emitTerminal("session.idle");
    await flushAsync();

    emitAssistantText("msg_2", "Second");
    emitTerminal("session.idle");
    await flushAsync();

    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenNthCalledWith(1, SESSION_ID, "msg_1", "First", {});
    expect(onComplete).toHaveBeenNthCalledWith(2, SESSION_ID, "msg_2", "Second", {});
    expect(onSessionIdle).toHaveBeenCalledTimes(2);
  });

  it("finalises every turn when only session.execution.succeeded is emitted", async () => {
    emitAssistantText("msg_1", "First");
    emitTerminal("session.execution.succeeded");
    await flushAsync();

    emitAssistantText("msg_2", "Second");
    emitTerminal("session.execution.succeeded");
    await flushAsync();

    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(onSessionIdle).toHaveBeenCalledTimes(2);
  });

  it("finalises every turn when both signals are emitted each turn", async () => {
    emitAssistantText("msg_1", "First");
    emitTerminal("session.execution.succeeded");
    emitTerminal("session.idle");
    await flushAsync();

    emitAssistantText("msg_2", "Second");
    emitTerminal("session.execution.succeeded");
    emitTerminal("session.idle");
    await flushAsync();

    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(onSessionIdle).toHaveBeenCalledTimes(2);
  });

  it("does not treat session.execution.failed as success", async () => {
    emitAssistantText("msg_1", "Partial answer");
    emitTerminal("session.execution.failed");
    await flushAsync();

    expect(onComplete).not.toHaveBeenCalled();
    expect(onSessionIdle).not.toHaveBeenCalled();
    expect(onSessionError).toHaveBeenCalledTimes(1);
    expect(onSessionError).toHaveBeenCalledWith(SESSION_ID, "boom");
  });

  it("does not treat session.execution.interrupted as success", async () => {
    emitAssistantText("msg_1", "Partial answer");
    emitTerminal("session.execution.interrupted");
    await flushAsync();

    expect(onComplete).not.toHaveBeenCalled();
    expect(onSessionIdle).not.toHaveBeenCalled();
    expect(onSessionError).toHaveBeenCalledTimes(1);
    expect(onSessionError).toHaveBeenCalledWith(SESSION_ID, "Session interrupted");
  });

  it("ignores session.execution.succeeded for other sessions", async () => {
    emitAssistantText("msg_1", "Hello there");
    summaryAggregator.processEvent(
      makeEvent("session.execution.succeeded", { sessionID: "sess_other" }),
    );
    await flushAsync();

    expect(onComplete).not.toHaveBeenCalled();
    expect(onSessionIdle).not.toHaveBeenCalled();
  });

  it("does not change streaming previews when completing on session.execution.succeeded", async () => {
    emitAssistantText("msg_1", "Hello there");
    await flushAsync();
    const partialCallsBeforeCompletion = onPartial.mock.calls.length;

    emitTerminal("session.execution.succeeded");
    await flushAsync();

    expect(onPartial.mock.calls.length).toBe(partialCallsBeforeCompletion);
  });
});
