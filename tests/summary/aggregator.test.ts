import { beforeEach, describe, expect, it, vi } from "vitest";
import type { V2Event } from "@opencode/client/promise";
import { summaryAggregator } from "../../src/summary/aggregator.js";
import { t } from "../../src/i18n/index.js";

/**
 * Test-only helper: converts a legacy event fixture { type, properties } to a
 * native V2Event shape.  Covers the legacy event types actually used in these
 * tests.  Unrecognised types are passed through with an empty `data` object.
 */
function toV2Event(
  legacy: { type: string; properties: Record<string, unknown> },
  extra?: Record<string, unknown>,
): V2Event {
  const { type, properties } = legacy;

  const base = {
    id: "evt-1",
    created: Date.now(),
    ...extra,
  };

  switch (type) {
    case "session.created":
      return {
        ...base,
        type: "session.created",
        durable: { aggregateID: "agg-1", seq: 1, version: 1 },
        data: {
          sessionID: (properties.info as any)?.id ?? "session-1",
          parentID: (properties.info as any)?.parentID,
          title: (properties.info as any)?.title,
        },
      } as V2Event;

    case "session.updated":
      return {
        ...base,
        type: "session.renamed",
        durable: { aggregateID: "agg-1", seq: 1, version: 1 },
        data: {
          sessionID: (properties.info as any)?.id ?? "session-1",
          title: (properties.info as any)?.title,
        },
      } as V2Event;

    case "session.status":
      return {
        ...base,
        type: "session.status",
        data: {
          sessionID: (properties as any).sessionID ?? "session-1",
          status: (properties as any).status ?? { type: "busy" },
        },
      } as V2Event;

    case "session.idle":
      return {
        ...base,
        type: "session.idle",
        data: { sessionID: (properties as any).sessionID ?? "session-1" },
      } as V2Event;

    case "session.error":
      return {
        ...base,
        type: "session.execution.failed",
        durable: { aggregateID: "agg-1", seq: 1, version: 1 },
        data: {
          sessionID: (properties as any).sessionID ?? "session-1",
          error: {
            type: "error",
            message: (properties as any).error?.message ?? (properties as any).error ?? "error",
          },
        },
      } as V2Event;

    case "session.compacted":
      return {
        ...base,
        type: "session.compaction.ended",
        data: { sessionID: (properties as any).sessionID ?? "session-1" },
      } as V2Event;

    case "message.updated": {
      const info = (properties as any).info;
      // Convert to session.text.started + session.text.ended pair
      return {
        ...base,
        type: "session.text.ended",
        durable: { aggregateID: "agg-1", seq: 1, version: 1 },
        data: {
          sessionID: info.sessionID,
          assistantMessageID: info.id,
          ordinal: 0,
          text: "",
          state: undefined,
        },
      } as V2Event;
    }

    case "message.part.updated": {
      const part = (properties as any).part;
      if (part.type === "tool") {
        if (part.state?.status === "completed") {
          return {
            ...base,
            type: "session.tool.success",
            durable: { aggregateID: "agg-1", seq: 1, version: 1 },
            data: {
              sessionID: part.sessionID,
              assistantMessageID: part.messageID,
              id: part.callID,
              content: [] as any,
              metadata: { tool: part.tool, ...(part.state.metadata || {}) },
              executed: true,
            },
          } as V2Event;
        }
        if (part.state?.status === "error") {
          return {
            ...base,
            type: "session.tool.failed",
            durable: { aggregateID: "agg-1", seq: 1, version: 1 },
            data: {
              sessionID: part.sessionID,
              assistantMessageID: part.messageID,
              id: part.callID,
              error: { type: "error", message: "tool failed" },
              content: [] as any,
              metadata: { tool: part.tool, ...(part.state.metadata || {}) },
              executed: false,
            },
          } as V2Event;
        }
        // streaming/running
        return {
          ...base,
          type: "session.tool.called",
          durable: { aggregateID: "agg-1", seq: 1, version: 1 },
          data: {
            sessionID: part.sessionID,
            assistantMessageID: part.messageID,
            id: part.callID,
            input: { tool: part.tool, ...(part.state?.input || {}) },
            executed: false,
          },
        } as V2Event;
      }
      if (part.type === "text") {
        return {
          ...base,
          type: "session.text.ended",
          durable: { aggregateID: "agg-1", seq: 1, version: 1 },
          data: {
            sessionID: part.sessionID,
            assistantMessageID: part.messageID,
            ordinal: 0,
            text: part.text ?? "",
          },
        } as V2Event;
      }
      if (part.type === "reasoning") {
        return {
          ...base,
          type: "session.reasoning.started",
          durable: { aggregateID: "agg-1", seq: 1, version: 1 },
          data: {
            sessionID: part.sessionID,
            assistantMessageID: part.messageID,
            ordinal: 0,
          },
        } as V2Event;
      }
      if (part.type === "subtask") {
        // Map subtask to session.created for the child session
        return {
          ...base,
          type: "session.created",
          durable: { aggregateID: "agg-1", seq: 1, version: 1 },
          data: {
            sessionID: "child-session",
            parentID: part.sessionID,
            title: part.description || "subtask",
          },
        } as V2Event;
      }
      // step-start / step-finish
      if (part.type === "step-start") {
        return {
          ...base,
          type: "session.step.started",
          durable: { aggregateID: "agg-1", seq: 1, version: 1 },
          data: { sessionID: part.sessionID },
        } as V2Event;
      }
      if (part.type === "step-finish") {
        return {
          ...base,
          type: "session.step.ended",
          durable: { aggregateID: "agg-1", seq: 1, version: 1 },
          data: {
            sessionID: part.sessionID,
            tokens: part.tokens,
            cost: part.cost,
          },
        } as V2Event;
      }
      // Fallback: unknown part type
      return {
        ...base,
        type: "session.text.ended",
        durable: { aggregateID: "agg-1", seq: 1, version: 1 },
        data: { sessionID: part.sessionID, assistantMessageID: part.messageID, ordinal: 0, text: "" },
      } as V2Event;
    }

    case "message.part.delta": {
      const partProps = (properties as any).part;
      return {
        ...base,
        type: "session.text.delta",
        durable: { aggregateID: "agg-1", seq: 1, version: 1 },
        data: {
          sessionID: partProps?.sessionID ?? (properties as any).sessionID ?? "session-1",
          assistantMessageID: partProps?.messageID ?? (properties as any).messageID ?? "message-1",
          ordinal: 0,
          delta: (properties as any).delta ?? "",
          state: undefined,
        },
      } as V2Event;
    }

    case "form.created":
      return {
        ...base,
        type: "form.created",
        data: { form: (properties as any).form },
      } as V2Event;

    case "form.replied":
      return {
        ...base,
        type: "form.replied",
        data: { id: (properties as any).id, sessionID: (properties as any).sessionID },
      } as V2Event;

    case "form.cancelled":
      return {
        ...base,
        type: "form.cancelled",
        data: { id: (properties as any).id, sessionID: (properties as any).sessionID },
      } as V2Event;

    case "permission.asked":
      return {
        ...base,
        type: "permission.asked",
        data: { ...(properties as any) },
      } as V2Event;

    case "session.diff":
      // V1-only; ignore
      return {
        ...base,
        type: "session.idle",
        data: { sessionID: (properties as any).sessionID ?? "session-1" },
      } as V2Event;

    case "question.asked":
      // Removed in V2; convert to form.created
      return {
        ...base,
        type: "form.created",
        data: {
          form: {
            id: (properties as any).id ?? "q-1",
            sessionID: (properties as any).sessionID ?? "session-1",
            title: "Question",
            fields: [],
          },
        },
      } as V2Event;

    default:
      return {
        ...base,
        type: type as any,
        data: properties as any,
      } as V2Event;
  }
}

/** Builds a native V2 event for tests that exercise V2-only behaviour. */
function v2Event(type: string, data: Record<string, unknown>): V2Event {
  return { id: "evt-1", created: Date.now(), type, data } as unknown as V2Event;
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

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

describe("summary/aggregator", () => {
  beforeEach(() => {
    mocked.getCurrentProjectMock.mockReset();
    mocked.getCurrentProjectMock.mockReturnValue({ id: "p1", worktree: "D:/repo", name: "repo" });
    summaryAggregator.clear();
    summaryAggregator.setOnCleared(() => {});
    summaryAggregator.setOnTool(() => {});
    summaryAggregator.setOnToolFile(() => {});
    summaryAggregator.setOnPartial(() => {});
    summaryAggregator.setOnExternalUserInput(() => {});
    summaryAggregator.setOnThinking(() => {});
    summaryAggregator.setOnSubagent(() => {});
    summaryAggregator.setOnSessionIdle(() => {});
    summaryAggregator.setOnSessionError(() => {});
    summaryAggregator.setOnSessionRetry(() => {});
  });

  it("invokes onCleared callback when aggregator is cleared", () => {
    const onCleared = vi.fn();
    summaryAggregator.setOnCleared(onCleared);

    summaryAggregator.clear();

    expect(onCleared).toHaveBeenCalledTimes(1);
  });

  it("includes sessionId in tool callback payload", () => {
    const onTool = vi.fn();
    summaryAggregator.setOnTool(onTool);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(toV2Event({
      type: "message.updated",
      properties: {
        info: {
          id: "message-1",
          sessionID: "session-1",
          role: "assistant",
          time: { created: Date.now() },
        },
      },
    }) as V2Event);

    summaryAggregator.processEvent(toV2Event({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-1",
          sessionID: "session-1",
          messageID: "message-1",
          type: "tool",
          callID: "call-1",
          tool: "bash",
          state: {
            status: "completed",
            input: {
              command: "npm test",
            },
            metadata: {},
          },
        },
      },
    }) as V2Event);

    expect(onTool).toHaveBeenCalledTimes(1);
    expect(onTool.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        callId: "call-1",
        tool: "bash",
        hasFileAttachment: false,
      }),
    );
  });

  // KNOWN GAP (V2 migration): the aggregator never calls subagentTracker.updateFromAssistantMessage/updateStepFinish, and
  // real session.tool.called events carry no tool name (it arrives in session.tool.input.started).
  it.todo("emits live subagent updates with per-session model, context, cost, and current tool");

  // KNOWN GAP (V2 migration): pending cards are only created by subagentTracker.registerSubtaskPart, which no V2 event handler calls.
  it.todo("attaches unknown child session events to pending subagent cards before session.created");

  it("tracks multiple parallel subagents independently", () => {
    const onSubagent = vi.fn();
    summaryAggregator.setOnSubagent(onSubagent);
    summaryAggregator.setSession("root-session");

    const subtasks = [
      { agent: "explore", description: "first task", child: "child-1" },
      { agent: "general", description: "second task", child: "child-2" },
    ];

    for (const item of subtasks) {
      summaryAggregator.processEvent(
        v2Event("session.created", {
          sessionID: item.child,
          parentID: "root-session",
          title: `${item.description} (@${item.agent} subagent)`,
        }),
      );

      summaryAggregator.processEvent(
        v2Event("session.tool.called", {
          sessionID: item.child,
          assistantMessageID: `message-${item.child}`,
          id: `call-${item.child}`,
          input: { command: `echo ${item.child}` },
          executed: false,
        }),
      );
    }

    expect(onSubagent.mock.lastCall?.[1]).toHaveLength(2);
    expect(onSubagent.mock.lastCall?.[1]).toEqual([
      expect.objectContaining({
        sessionId: "child-1",
        description: "first task",
        agent: "explore",
        status: "running",
        currentToolInput: { command: "echo child-1" },
      }),
      expect.objectContaining({
        sessionId: "child-2",
        description: "second task",
        agent: "general",
        status: "running",
        currentToolInput: { command: "echo child-2" },
      }),
    ]);
  });

  it("keeps subagent cards and updates terminal status for child sessions", () => {
    const onSubagent = vi.fn();
    summaryAggregator.setOnSubagent(onSubagent);
    summaryAggregator.setSession("root-session");

    summaryAggregator.processEvent(
      v2Event("session.created", {
        sessionID: "child-done",
        parentID: "root-session",
        title: "done task (@explore subagent)",
      }),
    );
    summaryAggregator.processEvent(v2Event("session.idle", { sessionID: "child-done" }));

    summaryAggregator.processEvent(
      v2Event("session.created", {
        sessionID: "child-error",
        parentID: "root-session",
        title: "failed task (@general subagent)",
      }),
    );
    summaryAggregator.processEvent(
      v2Event("session.execution.failed", {
        sessionID: "child-error",
        error: { type: "error", message: "Task failed" },
      }),
    );

    expect(onSubagent.mock.lastCall?.[1]).toEqual([
      expect.objectContaining({ sessionId: "child-done", status: "completed" }),
      expect.objectContaining({
        sessionId: "child-error",
        status: "error",
        terminalMessage: "Task failed",
      }),
    ]);
  });

  it("does not re-emit completed subagent cards for unchanged late child session updates", () => {
    const onSubagent = vi.fn();
    summaryAggregator.setOnSubagent(onSubagent);
    summaryAggregator.setSession("root-session");

    summaryAggregator.processEvent(
      v2Event("session.created", {
        sessionID: "child-done",
        parentID: "root-session",
        title: "done task (@explore subagent)",
      }),
    );
    summaryAggregator.processEvent(v2Event("session.idle", { sessionID: "child-done" }));

    expect(onSubagent.mock.lastCall?.[1]).toEqual([
      expect.objectContaining({ sessionId: "child-done", status: "completed" }),
    ]);
    const callsAfterIdle = onSubagent.mock.calls.length;

    summaryAggregator.processEvent(
      v2Event("session.renamed", {
        sessionID: "child-done",
        title: "done task (@explore subagent)",
      }),
    );

    expect(onSubagent).toHaveBeenCalledTimes(callsAfterIdle);
  });

  it("marks write tool without file attachment when payload is oversized", () => {
    const onTool = vi.fn();
    const onToolFile = vi.fn();
    summaryAggregator.setOnTool(onTool);
    summaryAggregator.setOnToolFile(onToolFile);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(toV2Event({
      type: "message.updated",
      properties: {
        info: {
          id: "message-oversized",
          sessionID: "session-1",
          role: "assistant",
          time: { created: Date.now() },
        },
      },
    }) as V2Event);

    summaryAggregator.processEvent(toV2Event({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-oversized",
          sessionID: "session-1",
          messageID: "message-oversized",
          type: "tool",
          callID: "call-oversized",
          tool: "write",
          state: {
            status: "completed",
            input: {
              filePath: "src/huge.ts",
              content: "x".repeat(101 * 1024),
            },
            metadata: {},
          },
        },
      },
    }) as V2Event);

    expect(onTool).toHaveBeenCalledTimes(1);
    expect(onTool.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        tool: "write",
        hasFileAttachment: false,
      }),
    );
    expect(onToolFile).not.toHaveBeenCalled();
  });

  it("passes sessionId to thinking callback when reasoning part arrives", async () => {
    const onThinking = vi.fn();
    summaryAggregator.setOnThinking(onThinking);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(toV2Event({
      type: "message.updated",
      properties: {
        info: {
          id: "message-1",
          sessionID: "session-1",
          role: "assistant",
          time: { created: Date.now() },
        },
      },
    }) as V2Event);

    summaryAggregator.processEvent(toV2Event({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-reasoning-1",
          sessionID: "session-1",
          messageID: "message-1",
          type: "reasoning",
          text: "Let me think about this...",
          time: { start: Date.now() },
        },
      },
    }) as V2Event);

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onThinking).toHaveBeenCalledWith("session-1");
  });

  it("streams partial text and passes messageId on completion", async () => {
    const onPartial = vi.fn();
    const onComplete = vi.fn();

    summaryAggregator.setOnPartial(onPartial);
    summaryAggregator.setOnComplete(onComplete);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(
      v2Event("session.text.started", {
        sessionID: "session-1",
        assistantMessageID: "message-stream-1",
        ordinal: 0,
      }),
    );
    summaryAggregator.processEvent(
      v2Event("session.text.delta", {
        sessionID: "session-1",
        assistantMessageID: "message-stream-1",
        ordinal: 0,
        delta: "Partial answer",
      }),
    );
    summaryAggregator.processEvent(
      v2Event("session.execution.succeeded", { sessionID: "session-1" }),
    );
    await flushAsync();

    expect(onPartial).toHaveBeenCalledWith("session-1", "message-stream-1", "Partial answer");
    expect(onComplete).toHaveBeenCalledWith(
      "session-1",
      "message-stream-1",
      "Partial answer",
      expect.objectContaining({}),
    );
  });

  // KNOWN GAP (V2 migration): session.inbox.* events are bridged with empty text; the text
  // accumulation path (applyTextDelta/emitExternalUserInputIfReady) is no longer called by any V2 handler.
  it.todo("emits completed external user input for the current session");

  it("ignores external user input from a different session", async () => {
    const onExternalUserInput = vi.fn();
    summaryAggregator.setOnExternalUserInput(onExternalUserInput);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(toV2Event({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-user-other",
          sessionID: "session-2",
          messageID: "message-user-other",
          type: "text",
          text: "Hello from another session",
          time: { start: Date.now() },
        },
      },
    }) as V2Event);

    summaryAggregator.processEvent(toV2Event({
      type: "message.updated",
      properties: {
        info: {
          id: "message-user-other",
          sessionID: "session-2",
          role: "user",
          time: { created: Date.now() },
        },
      },
    }) as V2Event);

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onExternalUserInput).not.toHaveBeenCalled();
  });

  it("does not emit whitespace-only external user input", async () => {
    const onExternalUserInput = vi.fn();
    summaryAggregator.setOnExternalUserInput(onExternalUserInput);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(toV2Event({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-user-empty",
          sessionID: "session-1",
          messageID: "message-user-empty",
          type: "text",
          text: "   ",
          time: { start: Date.now() },
        },
      },
    }) as V2Event);

    summaryAggregator.processEvent(toV2Event({
      type: "message.updated",
      properties: {
        info: {
          id: "message-user-empty",
          sessionID: "session-1",
          role: "user",
          time: { created: Date.now() },
        },
      },
    }) as V2Event);

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onExternalUserInput).not.toHaveBeenCalled();
  });

  it("combines multiple text parts into a single final message", async () => {
    const onPartial = vi.fn();
    const onComplete = vi.fn();

    summaryAggregator.setOnPartial(onPartial);
    summaryAggregator.setOnComplete(onComplete);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(
      v2Event("session.text.ended", {
        sessionID: "session-1",
        assistantMessageID: "message-multipart-1",
        ordinal: 0,
        text: "Hello ",
      }),
    );
    summaryAggregator.processEvent(
      v2Event("session.text.ended", {
        sessionID: "session-1",
        assistantMessageID: "message-multipart-1",
        ordinal: 1,
        text: "world",
      }),
    );
    summaryAggregator.processEvent(
      v2Event("session.execution.succeeded", { sessionID: "session-1" }),
    );
    await flushAsync();

    expect(onPartial).toHaveBeenLastCalledWith("session-1", "message-multipart-1", "Hello world");
    expect(onComplete).toHaveBeenCalledWith(
      "session-1",
      "message-multipart-1",
      "Hello world",
      expect.objectContaining({}),
    );
  });

  it("reports root session.idle through callback", async () => {
    const onSessionIdle = vi.fn();
    summaryAggregator.setOnSessionIdle(onSessionIdle);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(toV2Event({
      type: "session.idle",
      properties: {
        sessionID: "session-1",
      },
    }) as V2Event);

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onSessionIdle).toHaveBeenCalledWith("session-1");
  });

  // KNOWN GAP (V2 migration): the V2 completion flush always passes an empty MessageCompletionInfo
  // ({}), so agent/providerID/modelID/createdAt/completedAt never reach the footer.
  it.todo("passes assistant metadata to onComplete");

  it("streams text from message.part.delta events", () => {
    const onPartial = vi.fn();
    summaryAggregator.setOnPartial(onPartial);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(toV2Event({
      type: "message.part.delta",
      properties: {
        part: {
          id: "part-delta-1",
          sessionID: "session-1",
          messageID: "message-delta-1",
          type: "text",
        },
        delta: "Hel",
      },
    }) as V2Event);

    summaryAggregator.processEvent(toV2Event({
      type: "message.part.delta",
      properties: {
        part: {
          id: "part-delta-1",
          sessionID: "session-1",
          messageID: "message-delta-1",
          type: "text",
        },
        delta: "lo",
      },
    }) as V2Event);

    expect(onPartial).toHaveBeenNthCalledWith(1, "session-1", "message-delta-1", "Hel");
    expect(onPartial).toHaveBeenNthCalledWith(2, "session-1", "message-delta-1", "Hello");
  });

  it("streams delta events even when part type is omitted", () => {
    const onPartial = vi.fn();
    summaryAggregator.setOnPartial(onPartial);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(toV2Event({
      type: "message.part.delta",
      properties: {
        part: {
          id: "part-delta-unknown-type",
          sessionID: "session-1",
          messageID: "message-delta-unknown-type",
        },
        delta: "Hi",
      },
    }) as V2Event);

    expect(onPartial).toHaveBeenCalledWith("session-1", "message-delta-unknown-type", "Hi");
  });

  it("does not stream reasoning deltas as assistant text", () => {
    const onPartial = vi.fn();
    summaryAggregator.setOnPartial(onPartial);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(
      v2Event("session.reasoning.started", {
        sessionID: "session-1",
        assistantMessageID: "message-reasoning-1",
        ordinal: 0,
      }),
    );
    summaryAggregator.processEvent(
      v2Event("session.reasoning.delta", {
        sessionID: "session-1",
        assistantMessageID: "message-reasoning-1",
        ordinal: 0,
        delta: "internal thoughts",
      }),
    );

    expect(onPartial).not.toHaveBeenCalled();
  });

  it("does not send thinking callback when no reasoning part arrives", async () => {
    const onThinking = vi.fn();
    summaryAggregator.setOnThinking(onThinking);
    summaryAggregator.setSession("session-1");

    // Only a message.updated event without any reasoning part — should NOT trigger thinking
    summaryAggregator.processEvent(toV2Event({
      type: "message.updated",
      properties: {
        info: {
          id: "message-no-reasoning",
          sessionID: "session-1",
          role: "assistant",
          time: { created: Date.now() },
        },
      },
    }) as V2Event);

    summaryAggregator.processEvent(toV2Event({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-text-1",
          sessionID: "session-1",
          messageID: "message-no-reasoning",
          type: "text",
          text: "Here is my answer.",
          time: { start: Date.now() },
        },
      },
    }) as V2Event);

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onThinking).not.toHaveBeenCalled();
  });

  it("fires thinking callback only once per message even with multiple reasoning parts", async () => {
    const onThinking = vi.fn();
    summaryAggregator.setOnThinking(onThinking);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(toV2Event({
      type: "message.updated",
      properties: {
        info: {
          id: "message-multi-reasoning",
          sessionID: "session-1",
          role: "assistant",
          time: { created: Date.now() },
        },
      },
    }) as V2Event);

    for (let i = 0; i < 3; i++) {
      summaryAggregator.processEvent(toV2Event({
        type: "message.part.updated",
        properties: {
          part: {
            id: `part-reasoning-${i}`,
            sessionID: "session-1",
            messageID: "message-multi-reasoning",
            type: "reasoning",
            text: `Thinking step ${i}`,
            time: { start: Date.now() },
          },
        },
      }) as V2Event);
    }

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onThinking).toHaveBeenCalledTimes(1);
    expect(onThinking).toHaveBeenCalledWith("session-1");
  });

  it("reports session.execution.failed message through callback", async () => {
    const onSessionError = vi.fn();
    summaryAggregator.setOnSessionError(onSessionError);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(
      v2Event("session.execution.failed", {
        sessionID: "session-1",
        error: { type: "UnknownError", message: "Model not found: opencode/foo." },
      }),
    );
    await flushAsync();

    expect(onSessionError).toHaveBeenCalledWith("session-1", "Model not found: opencode/foo.");
  });

  it("reports session.status retry through callback", async () => {
    const onSessionRetry = vi.fn();
    summaryAggregator.setOnSessionRetry(onSessionRetry);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(toV2Event({
      type: "session.status",
      properties: {
        sessionID: "session-1",
        status: {
          type: "retry",
          attempt: 2,
          message: "Your current subscription plan does not yet include access to GLM-5",
          next: 1772203141283,
        },
      },
    }) as V2Event);

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onSessionRetry).toHaveBeenCalledWith({
      sessionId: "session-1",
      attempt: 2,
      message: "Your current subscription plan does not yet include access to GLM-5",
      next: 1772203141283,
    });
  });

  it("sends apply_patch payload as tool file", () => {
    const onToolFile = vi.fn();
    summaryAggregator.setOnToolFile(onToolFile);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(toV2Event({
      type: "message.updated",
      properties: {
        info: {
          id: "message-1",
          sessionID: "session-1",
          role: "assistant",
          time: { created: Date.now() },
        },
      },
    }) as V2Event);

    summaryAggregator.processEvent(toV2Event({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-1",
          sessionID: "session-1",
          messageID: "message-1",
          type: "tool",
          callID: "call-apply-patch",
          tool: "apply_patch",
          state: {
            status: "completed",
            input: {
              patchText: "irrelevant for formatter in this path",
            },
            metadata: {
              filediff: {
                file: "D:/repo/src/one.ts",
                additions: 2,
                deletions: 1,
              },
              diff: [
                "@@ -1,2 +1,3 @@",
                "--- a/src/one.ts",
                "+++ b/src/one.ts",
                " old",
                "-before",
                "+after",
                "+extra",
              ].join("\n"),
            },
          },
        },
      },
    }) as V2Event);

    expect(onToolFile).toHaveBeenCalledTimes(1);

    const filePayload = onToolFile.mock.calls[0][0] as {
      sessionId: string;
      tool: string;
      hasFileAttachment: boolean;
      fileData: {
        filename: string;
        buffer: Buffer;
      };
    };

    expect(filePayload.sessionId).toBe("session-1");
    expect(filePayload.tool).toBe("apply_patch");
    expect(filePayload.hasFileAttachment).toBe(true);
    expect(filePayload.fileData.filename).toBe("edit_one.ts.txt");
    expect(filePayload.fileData.buffer.toString("utf8")).toContain(t("tool.file_header.edit", { path: "src/one.ts" }).split("\n")[0]);
  });

  // KNOWN GAP (V2 migration): session.tool.success carries neither the tool input nor a title,
  // so the title/patchText fallback in prepareToolFileContext is unreachable for successful tools.
  it.todo("sends apply_patch file using title and patchText fallback");

  it("fires onTokens with isCompleted=true on session.usage.updated", () => {
    const onTokens = vi.fn();
    summaryAggregator.setOnTokens(onTokens);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(
      v2Event("session.usage.updated", {
        sessionID: "session-1",
        tokens: { input: 800, output: 200, reasoning: 0, cache: { read: 100, write: 0 } },
        cost: 0.01,
      }),
    );

    expect(onTokens).toHaveBeenCalledTimes(1);
    expect(onTokens).toHaveBeenCalledWith(
      expect.objectContaining({ input: 800, output: 200, cacheRead: 100 }),
      true,
    );
  });

  it("fires onTokens with isCompleted=false on session.step.ended", () => {
    const onTokens = vi.fn();
    summaryAggregator.setOnTokens(onTokens);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(
      v2Event("session.step.ended", {
        sessionID: "session-1",
        assistantMessageID: "msg-tokens-intermediate",
        tokens: { input: 500, output: 50, reasoning: 0, cache: { read: 200, write: 0 } },
      }),
    );

    expect(onTokens).toHaveBeenCalledTimes(1);
    expect(onTokens).toHaveBeenCalledWith(
      expect.objectContaining({ input: 500, output: 50, cacheRead: 200 }),
      false,
    );
  });

  it("fires onTokens for every step, including zero-token steps (filtered by the bot layer)", () => {
    const onTokens = vi.fn();
    summaryAggregator.setOnTokens(onTokens);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(
      v2Event("session.step.ended", {
        sessionID: "session-1",
        assistantMessageID: "msg-step2",
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );

    // The callback IS fired (filtering zero tokens is done in event-subscription.ts)
    expect(onTokens).toHaveBeenCalledTimes(1);
    expect(onTokens).toHaveBeenCalledWith(expect.objectContaining({ input: 0, cacheRead: 0 }), false);

    onTokens.mockClear();

    summaryAggregator.processEvent(
      v2Event("session.step.ended", {
        sessionID: "session-1",
        assistantMessageID: "msg-step2",
        tokens: { input: 4000, output: 300, reasoning: 0, cache: { read: 12000, write: 0 } },
      }),
    );

    expect(onTokens).toHaveBeenCalledTimes(1);
    expect(onTokens).toHaveBeenCalledWith(
      expect.objectContaining({ input: 4000, cacheRead: 12000 }),
      false,
    );
  });

  it("does not fire onTokens when message.updated has no tokens field", () => {
    const onTokens = vi.fn();
    summaryAggregator.setOnTokens(onTokens);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(toV2Event({
      type: "message.updated",
      properties: {
        info: {
          id: "msg-no-tokens",
          sessionID: "session-1",
          role: "assistant",
          time: { created: Date.now() },
        },
      },
    }) as V2Event);

    expect(onTokens).not.toHaveBeenCalled();
  });

  // ── Cost callback ─────────────────────────────────────────────────────────
  it("fires onCost with the usage cost on completion", () => {
    const onCost = vi.fn();
    summaryAggregator.setOnCost(onCost);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(
      v2Event("session.usage.updated", {
        sessionID: "session-1",
        tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0.0123,
      }),
    );

    expect(onCost).toHaveBeenCalledTimes(1);
    expect(onCost).toHaveBeenCalledWith(0.0123);
  });

  it("does not fire onCost when cost is undefined", () => {
    const onCost = vi.fn();
    summaryAggregator.setOnCost(onCost);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(toV2Event({
      type: "message.updated",
      properties: {
        info: {
          id: "msg-no-cost",
          sessionID: "session-1",
          role: "assistant",
          time: { created: 1000, completed: 2000 },
          tokens: {
            input: 100,
            output: 50,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    }) as V2Event);

    expect(onCost).not.toHaveBeenCalled();
  });

  // ── Permission flows ───────────────────────────────────────────────────
  it("fires onPermission for permission.asked on the current session", async () => {
    const onPermission = vi.fn();
    summaryAggregator.setOnPermission(onPermission);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(toV2Event({
      type: "permission.asked",
      properties: {
        id: "perm-1",
        sessionID: "session-1",
        permission: "fileSystem.write",
        patterns: ["/src/**"],
        reason: "Needs to write tests",
      },
    }) as V2Event);

    await new Promise((resolve) => setImmediate(resolve));

    expect(onPermission).toHaveBeenCalledTimes(1);
    expect(onPermission.mock.calls[0][0]).toMatchObject({
      id: "perm-1",
      sessionID: "session-1",
      permission: "fileSystem.write",
    });
  });

  it("ignores permission.asked from a non-current session", async () => {
    const onPermission = vi.fn();
    summaryAggregator.setOnPermission(onPermission);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(toV2Event({
      type: "permission.asked",
      properties: {
        id: "perm-other",
        sessionID: "session-other",
        permission: "fileSystem.write",
        patterns: [],
        reason: "",
      },
    }) as V2Event);

    await new Promise((resolve) => setImmediate(resolve));
    expect(onPermission).not.toHaveBeenCalled();
  });

  // ── Session compacted ─────────────────────────────────────────────────────
  it("fires onSessionCompacted with the current project worktree", async () => {
    const onCompacted = vi.fn();
    summaryAggregator.setOnSessionCompacted(onCompacted);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(toV2Event({
      type: "session.compacted",
      properties: { sessionID: "session-1" },
    }) as V2Event);

    await new Promise((resolve) => setImmediate(resolve));

    expect(onCompacted).toHaveBeenCalledTimes(1);
    expect(onCompacted).toHaveBeenCalledWith("session-1", "D:/repo");
  });

  it("does not fire onSessionCompacted when no project is available", async () => {
    const onCompacted = vi.fn();
    summaryAggregator.setOnSessionCompacted(onCompacted);
    mocked.getCurrentProjectMock.mockReturnValue(undefined);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(toV2Event({
      type: "session.compacted",
      properties: { sessionID: "session-1" },
    }) as V2Event);

    await new Promise((resolve) => setImmediate(resolve));
    expect(onCompacted).not.toHaveBeenCalled();
  });

  // ── Tool dedup ────────────────────────────────────────────────────────────
  it("emits onTool exactly once when the same completed tool event arrives twice", () => {
    const onTool = vi.fn();
    summaryAggregator.setOnTool(onTool);
    summaryAggregator.setSession("session-1");

    summaryAggregator.processEvent(toV2Event({
      type: "message.updated",
      properties: {
        info: {
          id: "msg-dedup",
          sessionID: "session-1",
          role: "assistant",
          time: { created: Date.now() },
        },
      },
    }) as V2Event);

    const toolEvent = toV2Event({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-dedup",
          sessionID: "session-1",
          messageID: "msg-dedup",
          type: "tool",
          callID: "call-dedup",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "echo hi" },
            metadata: {},
          },
        },
      },
    });

    summaryAggregator.processEvent(toolEvent);
    summaryAggregator.processEvent(toolEvent);

    expect(onTool).toHaveBeenCalledTimes(1);
    expect(onTool.mock.calls[0][0]).toMatchObject({
      sessionId: "session-1",
      callId: "call-dedup",
      tool: "bash",
    });
  });
});
