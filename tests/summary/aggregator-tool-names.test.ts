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

const SESSION_ID = "ses_root";
const MESSAGE_ID = "msg_1";

function makeEvent(type: string, data: Record<string, unknown>): V2Event {
  return {
    id: `evt-${Math.random()}`,
    created: Date.now(),
    type,
    data,
  } as unknown as V2Event;
}

// Mirrors the real V2 sequence observed in production logs: only
// session.tool.input.started names the tool; tool.called carries the input;
// tool.success carries neither the name nor the input.
function emitToolRun(options: {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  sessionId?: string;
  failed?: boolean;
}): void {
  const sessionID = options.sessionId ?? SESSION_ID;
  const base = { sessionID, assistantMessageID: MESSAGE_ID, id: options.callId };

  summaryAggregator.processEvent(
    makeEvent("session.tool.input.started", { ...base, name: options.name }),
  );
  summaryAggregator.processEvent(
    makeEvent("session.tool.called", { ...base, input: options.input, executed: false }),
  );
  if (options.failed) {
    summaryAggregator.processEvent(
      makeEvent("session.tool.failed", {
        ...base,
        error: { type: "error", message: "tool failed" },
        metadata: options.metadata ?? {},
      }),
    );
    return;
  }
  summaryAggregator.processEvent(
    makeEvent("session.tool.success", {
      ...base,
      content: [{ type: "text", text: "ok" }],
      metadata: options.metadata ?? { status: "completed" },
      executed: false,
    }),
  );
}

describe("summary/aggregator tool names from V2 events", () => {
  const onTool = vi.fn();
  const onToolFile = vi.fn();
  const onFileChange = vi.fn();

  beforeEach(() => {
    mocked.getCurrentProjectMock.mockReset();
    mocked.getCurrentProjectMock.mockReturnValue({ id: "p1", worktree: "/repo", name: "repo" });
    summaryAggregator.clear();
    summaryAggregator.setOnCleared(() => {});
    summaryAggregator.setTypingIndicatorEnabled(false);
    summaryAggregator.setOnSubagent(() => {});

    onTool.mockReset();
    onToolFile.mockReset();
    onFileChange.mockReset();
    summaryAggregator.setOnTool(onTool);
    summaryAggregator.setOnToolFile(onToolFile);
    summaryAggregator.setOnFileChange(onFileChange);
    summaryAggregator.setSession(SESSION_ID);
  });

  it("names a shell tool from session.tool.input.started and keeps its input", () => {
    emitToolRun({ callId: "call_shell", name: "shell", input: { command: "ls -la" } });

    expect(onTool).toHaveBeenCalledTimes(1);
    expect(onTool).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: "call_shell",
        tool: "bash",
        input: { command: "ls -la" },
        hasFileAttachment: false,
      }),
    );
    expect(onToolFile).not.toHaveBeenCalled();
  });

  it("keeps V2 tool names that need no alias", () => {
    emitToolRun({ callId: "call_grep", name: "grep", input: { pattern: "TODO" } });

    expect(onTool).toHaveBeenCalledWith(expect.objectContaining({ tool: "grep" }));
  });

  it("sends a write tool as a file attachment and tracks the changed file", () => {
    emitToolRun({
      callId: "call_write",
      name: "write",
      input: { filePath: "/repo/src/new.ts", content: "line 1\nline 2" },
    });

    expect(onTool).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "write", hasFileAttachment: true }),
    );
    expect(onToolFile).toHaveBeenCalledTimes(1);
    expect(onToolFile).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "write", hasFileAttachment: true }),
    );
    expect(onFileChange).toHaveBeenCalledWith(
      expect.objectContaining({ file: "src/new.ts", additions: 2, deletions: 0 }),
    );
  });

  it("sends an edit tool diff as a file attachment and tracks the changed file", () => {
    emitToolRun({
      callId: "call_edit",
      name: "edit",
      input: { filePath: "/repo/src/one.ts", oldString: "before", newString: "after" },
      metadata: {
        diff: ["--- a/src/one.ts", "+++ b/src/one.ts", "@@ -1 +1 @@", "-before", "+after"].join(
          "\n",
        ),
        filediff: { file: "/repo/src/one.ts", additions: 1, deletions: 1 },
      },
    });

    expect(onToolFile).toHaveBeenCalledTimes(1);
    expect(onToolFile).toHaveBeenCalledWith(expect.objectContaining({ tool: "edit" }));
    expect(onFileChange).toHaveBeenCalledWith(
      expect.objectContaining({ file: "src/one.ts", additions: 1, deletions: 1 }),
    );
  });

  it("names failed tools too", () => {
    emitToolRun({ callId: "call_fail", name: "shell", input: { command: "false" }, failed: true });

    expect(onTool).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "bash",
        input: { command: "false" },
        state: expect.objectContaining({ status: "error" }),
      }),
    );
  });

  it("falls back to 'unknown' when no name was announced", () => {
    summaryAggregator.processEvent(
      makeEvent("session.tool.success", {
        sessionID: SESSION_ID,
        assistantMessageID: MESSAGE_ID,
        id: "call_anonymous",
        content: [{ type: "text", text: "ok" }],
        metadata: {},
        executed: false,
      }),
    );

    expect(onTool).toHaveBeenCalledWith(expect.objectContaining({ tool: "unknown" }));
  });

  it("reports the tool name on subagent cards for child sessions", () => {
    const onSubagent = vi.fn();
    summaryAggregator.setOnSubagent(onSubagent);
    summaryAggregator.processEvent(
      makeEvent("session.created", {
        sessionID: "ses_child",
        parentID: SESSION_ID,
        title: "Explore (@explore subagent)",
      }),
    );

    summaryAggregator.processEvent(
      makeEvent("session.tool.input.started", {
        sessionID: "ses_child",
        assistantMessageID: "msg_child",
        id: "call_child",
        name: "read",
      }),
    );
    summaryAggregator.processEvent(
      makeEvent("session.tool.called", {
        sessionID: "ses_child",
        assistantMessageID: "msg_child",
        id: "call_child",
        input: { filePath: "/repo/README.md" },
        executed: false,
      }),
    );

    expect(onSubagent.mock.lastCall?.[1]).toEqual([
      expect.objectContaining({
        sessionId: "ses_child",
        status: "running",
        currentTool: "read",
        currentToolInput: { filePath: "/repo/README.md" },
      }),
    ]);
  });

  it("forgets pending tool calls when the aggregator is cleared", () => {
    summaryAggregator.processEvent(
      makeEvent("session.tool.input.started", {
        sessionID: SESSION_ID,
        assistantMessageID: MESSAGE_ID,
        id: "call_stale",
        name: "shell",
      }),
    );
    summaryAggregator.clear();
    summaryAggregator.setSession(SESSION_ID);

    summaryAggregator.processEvent(
      makeEvent("session.tool.success", {
        sessionID: SESSION_ID,
        assistantMessageID: MESSAGE_ID,
        id: "call_stale",
        content: [{ type: "text", text: "ok" }],
        metadata: {},
        executed: false,
      }),
    );

    expect(onTool).toHaveBeenCalledWith(expect.objectContaining({ tool: "unknown" }));
  });
});
