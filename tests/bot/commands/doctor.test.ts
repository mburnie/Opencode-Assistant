import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import type { FormInfo } from "@opencode/client/promise";
import {
  collectDoctorReport,
  doctorCommand,
  EVENT_STREAM_STALL_MS,
  formatDoctorReport,
} from "../../../src/bot/commands/doctor.js";
import { formManager } from "../../../src/form/manager.js";
import { interactionManager } from "../../../src/interaction/manager.js";
import { clearAllInteractionState } from "../../../src/interaction/cleanup.js";
import { resolveInteractionGuardDecision } from "../../../src/interaction/guard.js";
import { foregroundSessionState } from "../../../src/scheduled-task/foreground-state.js";
import { attachManager } from "../../../src/attach/manager.js";
import { summaryAggregator } from "../../../src/summary/aggregator.js";
import { config } from "../../../src/config.js";

const mocked = vi.hoisted(() => ({
  healthMock: vi.fn(),
  activeSessionsMock: vi.fn(),
  eventStreamMock: vi.fn(),
  sessionModelMock: vi.fn(),
  currentSessionMock: vi.fn(),
  currentProjectMock: vi.fn(),
  dbMock: vi.fn(),
}));

vi.mock("../../../src/opencode/client-v2.js", () => ({
  checkServerHealth: mocked.healthMock,
  getActiveSessions: mocked.activeSessionsMock,
}));

vi.mock("../../../src/opencode/events.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/opencode/events.js")>(
    "../../../src/opencode/events.js",
  );
  return { ...actual, getEventStreamStatus: mocked.eventStreamMock };
});

vi.mock("../../../src/model/manager.js", () => ({
  fetchSessionModel: mocked.sessionModelMock,
}));

vi.mock("../../../src/session/manager.js", () => ({
  getCurrentSession: mocked.currentSessionMock,
}));

vi.mock("../../../src/settings/manager.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/settings/manager.js")>(
    "../../../src/settings/manager.js",
  );
  return { ...actual, getCurrentProject: mocked.currentProjectMock };
});

vi.mock("../../../src/memory/db.js", () => ({
  getDb: mocked.dbMock,
}));

const SESSION_ID = "ses_1";
const PROJECT_DIR = "/repo";

const TEST_FORM = {
  id: "form-1",
  sessionID: SESSION_ID,
  title: "Pick one",
  fields: [{ key: "choice", type: "string", title: "Choice" }],
} as unknown as FormInfo;

const fetchMock = vi.fn();

function telegramCtx(withIdentity = true) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const ctx = { me: withIdentity ? { id: 42 } : undefined, reply } as unknown as Context;
  return { ctx, reply };
}

function setHealthyEnvironment(): void {
  mocked.healthMock.mockResolvedValue({ healthy: true, version: "2.0.18" });
  mocked.activeSessionsMock.mockResolvedValue({ data: {} });
  mocked.eventStreamMock.mockReturnValue({
    listening: true,
    connected: true,
    directory: PROJECT_DIR,
    lastActivityAt: Date.now(),
  });
  mocked.sessionModelMock.mockResolvedValue({ providerID: "opencode", modelID: "big-pickle" });
  mocked.currentSessionMock.mockReturnValue({ id: SESSION_ID, title: "S", directory: PROJECT_DIR });
  mocked.currentProjectMock.mockReturnValue({ id: "p1", worktree: PROJECT_DIR, name: "repo" });
  mocked.dbMock.mockReturnValue({ prepare: () => ({ get: () => ({ n: 3 }) }) });
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
  vi.spyOn(summaryAggregator, "getLastTurnCompletion").mockReturnValue({
    event: "session.execution.succeeded",
    sessionId: SESSION_ID,
    at: Date.now(),
  });
}

describe("bot/commands/doctor", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    clearAllInteractionState("test_setup");
    foregroundSessionState.__resetForTests();
    attachManager.__resetForTests();
    setHealthyEnvironment();
  });

  it("reports HEALTHY with every check passing", async () => {
    const { ctx, reply } = telegramCtx();

    await doctorCommand(ctx as never);

    const port = new URL(config.opencode.apiUrl).port || "4096";
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0]).toBe(
      [
        "Leroy Health",
        "",
        "Telegram: PASS",
        `OpenCode ${port}: PASS (v2.0.18)`,
        "Model: PASS (opencode/big-pickle)",
        "Session: IDLE",
        "Event stream: PASS",
        `Memory MCP ${config.mcp.httpPort}: PASS`,
        "Memory DB: PASS",
        "Pending form: NONE",
        "Pending menu/interaction: NONE",
        "Busy state: CLEAR",
        "Last turn completion: session.execution.succeeded",
        "Overall: HEALTHY",
      ].join("\n"),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:${config.mcp.httpPort}/health`,
      expect.anything(),
    );
  });

  it("reports FAILED when OpenCode is unavailable and marks dependent checks UNKNOWN", async () => {
    mocked.healthMock.mockResolvedValue({ healthy: false, error: new Error("connect ECONNREFUSED") });

    const report = await collectDoctorReport(telegramCtx().ctx);

    expect(report.opencode).toEqual({ status: "FAIL", detail: "connect ECONNREFUSED" });
    expect(report.model.status).toBe("UNKNOWN");
    expect(report.session.status).toBe("UNKNOWN");
    expect(report.busyState).toEqual({ status: "CLEAR", detail: "not verified with OpenCode" });
    expect(report.overall).toBe("FAILED");
    expect(mocked.activeSessionsMock).not.toHaveBeenCalled();
  });

  it("reports FAILED when OpenCode health check hangs past the timeout", async () => {
    vi.useFakeTimers();
    mocked.healthMock.mockReturnValue(new Promise(() => {}));

    const pending = collectDoctorReport(telegramCtx().ctx);
    await vi.advanceTimersByTimeAsync(3500);
    const report = await pending;

    expect(report.opencode).toEqual({ status: "FAIL", detail: "OpenCode timed out" });
    expect(report.overall).toBe("FAILED");
  });

  it("reports FAILED when the memory MCP is unavailable", async () => {
    fetchMock.mockRejectedValue(new Error("fetch failed"));

    const report = await collectDoctorReport(telegramCtx().ctx);

    expect(report.memoryMcp).toEqual({ status: "FAIL", detail: "fetch failed" });
    expect(report.overall).toBe("FAILED");
  });

  it("reports FAILED when the memory MCP answers unhealthy", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    const report = await collectDoctorReport(telegramCtx().ctx);

    expect(report.memoryMcp).toEqual({ status: "FAIL", detail: "HTTP 500" });
    expect(report.overall).toBe("FAILED");
  });

  it("reports FAILED when the memory DB cannot be queried", async () => {
    mocked.dbMock.mockImplementation(() => {
      throw new Error("SQLITE_CANTOPEN");
    });

    const report = await collectDoctorReport(telegramCtx().ctx);

    expect(report.memoryDb).toEqual({ status: "FAIL", detail: "SQLITE_CANTOPEN" });
    expect(report.overall).toBe("FAILED");
  });

  it("reports FAILED when the Telegram bot identity is unknown", async () => {
    const report = await collectDoctorReport(telegramCtx(false).ctx);

    expect(report.telegram.status).toBe("FAIL");
    expect(report.overall).toBe("FAILED");
  });

  it.each([
    [{ listening: false, connected: false, directory: null, lastActivityAt: null }, "not subscribed"],
    [{ listening: true, connected: false, directory: PROJECT_DIR, lastActivityAt: null }, "reconnecting"],
    [
      { listening: true, connected: true, directory: "/other", lastActivityAt: Date.now() },
      "subscribed to a different project",
    ],
  ])("reports FAILED when the event stream is unusable (%#)", async (stream, detail) => {
    mocked.eventStreamMock.mockReturnValue(stream);

    const report = await collectDoctorReport(telegramCtx().ctx);

    expect(report.eventStream).toEqual({ status: "FAIL", detail });
    expect(report.overall).toBe("FAILED");
  });

  it("reports FAILED when the event stream has stalled", async () => {
    mocked.eventStreamMock.mockReturnValue({
      listening: true,
      connected: true,
      directory: PROJECT_DIR,
      lastActivityAt: Date.now() - EVENT_STREAM_STALL_MS - 5000,
    });

    const report = await collectDoctorReport(telegramCtx().ctx);

    expect(report.eventStream.status).toBe("FAIL");
    expect(report.eventStream.detail).toMatch(/^stalled, no activity for/);
    expect(report.overall).toBe("FAILED");
  });

  it("reports event stream UNKNOWN (DEGRADED) when no project is selected", async () => {
    mocked.currentProjectMock.mockReturnValue(undefined);
    mocked.eventStreamMock.mockReturnValue({
      listening: false,
      connected: false,
      directory: null,
      lastActivityAt: null,
    });

    const report = await collectDoctorReport(telegramCtx().ctx);

    expect(report.eventStream).toEqual({ status: "UNKNOWN", detail: "no project selected" });
    expect(report.overall).toBe("DEGRADED");
  });

  it("reports an active form as DEGRADED without clearing it", async () => {
    formManager.startForm(TEST_FORM);
    interactionManager.start({ kind: "form", expectedInput: "callback" });

    const report = await collectDoctorReport(telegramCtx().ctx);

    expect(report.pendingForm).toEqual({ status: "ACTIVE", detail: "form-1" });
    expect(report.pendingInteraction.status).toBe("NONE");
    expect(report.overall).toBe("DEGRADED");
    expect(formManager.isActive()).toBe(true);
    expect(interactionManager.getSnapshot()?.kind).toBe("form");
  });

  it("reports an active menu interaction as DEGRADED, and /doctor stays usable during it", async () => {
    interactionManager.start({ kind: "custom", expectedInput: "callback" });

    const guard = resolveInteractionGuardDecision({ message: { text: "/doctor" } } as unknown as Context);
    expect(guard.allow).toBe(true);

    const report = await collectDoctorReport(telegramCtx().ctx);

    expect(report.pendingInteraction).toEqual({
      status: "ACTIVE",
      detail: "custom, waiting for callback",
    });
    expect(report.overall).toBe("DEGRADED");
    expect(interactionManager.getSnapshot()?.kind).toBe("custom");
  });

  it("reports INCONSISTENT when Leroy is busy but OpenCode is idle", async () => {
    foregroundSessionState.markBusy(SESSION_ID);

    const guard = resolveInteractionGuardDecision({ message: { text: "/doctor" } } as unknown as Context);
    expect(guard.allow).toBe(true);

    const report = await collectDoctorReport(telegramCtx().ctx);

    expect(report.session.status).toBe("IDLE");
    expect(report.busyState).toEqual({ status: "INCONSISTENT", detail: "Leroy busy, OpenCode idle" });
    expect(report.overall).toBe("DEGRADED");
    expect(foregroundSessionState.isBusy()).toBe(true);
  });

  it("reports INCONSISTENT when OpenCode is busy but Leroy is idle", async () => {
    mocked.activeSessionsMock.mockResolvedValue({ data: { [SESSION_ID]: { type: "running" } } });

    const report = await collectDoctorReport(telegramCtx().ctx);

    expect(report.session.status).toBe("BUSY");
    expect(report.busyState).toEqual({ status: "INCONSISTENT", detail: "OpenCode busy, Leroy idle" });
    expect(report.overall).toBe("DEGRADED");
  });

  it("reports a consistent BUSY run as HEALTHY", async () => {
    mocked.activeSessionsMock.mockResolvedValue({ data: { [SESSION_ID]: { type: "running" } } });
    foregroundSessionState.markBusy(SESSION_ID);

    const report = await collectDoctorReport(telegramCtx().ctx);

    expect(report.session.status).toBe("BUSY");
    expect(report.busyState).toEqual({ status: "BUSY" });
    expect(report.overall).toBe("HEALTHY");
  });

  it("reports UNKNOWN last turn completion as DEGRADED", async () => {
    vi.spyOn(summaryAggregator, "getLastTurnCompletion").mockReturnValue(null);

    const report = await collectDoctorReport(telegramCtx().ctx);

    expect(report.lastTurnCompletion).toEqual({ status: "UNKNOWN" });
    expect(report.overall).toBe("DEGRADED");
  });

  it("reports a session without a model as Model FAIL (DEGRADED)", async () => {
    mocked.sessionModelMock.mockResolvedValue(null);

    const report = await collectDoctorReport(telegramCtx().ctx);

    expect(report.model).toEqual({ status: "FAIL", detail: "session has no model" });
    expect(report.overall).toBe("DEGRADED");
  });

  it("reports the real terminal event recorded by the aggregator", async () => {
    vi.mocked(summaryAggregator.getLastTurnCompletion).mockRestore();
    summaryAggregator.setSession(SESSION_ID);
    summaryAggregator.processEvent({
      id: "evt-1",
      created: Date.now(),
      type: "session.execution.succeeded",
      data: { sessionID: SESSION_ID },
    } as never);

    const report = await collectDoctorReport(telegramCtx().ctx);

    expect(report.lastTurnCompletion).toEqual({ status: "session.execution.succeeded" });
  });

  it("never prints the OpenCode server password", async () => {
    const password = config.opencode.password;
    const report = await collectDoctorReport(telegramCtx().ctx);
    const text = formatDoctorReport(report);

    if (password) {
      expect(text).not.toContain(password);
    }
    expect(text).not.toContain(config.telegram.token);
  });
});
