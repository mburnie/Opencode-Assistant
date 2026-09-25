import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  reconcileAttachedSessionBusyState,
  reconcileForegroundSessionBusyState,
} from "../../src/attach/service.js";
import { attachManager } from "../../src/attach/manager.js";
import { foregroundSessionState } from "../../src/scheduled-task/foreground-state.js";

const mocked = vi.hoisted(() => ({
  getActiveSessionsMock: vi.fn(),
}));

vi.mock("../../src/opencode/client-v2.js", () => ({
  getActiveSessions: mocked.getActiveSessionsMock,
}));

describe("attach/service reconcileAttachedSessionBusyState", () => {
  beforeEach(() => {
    attachManager.__resetForTests();
    mocked.getActiveSessionsMock.mockReset();
  });

  it("returns false and keeps manager unattached when no session is attached", async () => {
    mocked.getActiveSessionsMock.mockResolvedValue({ data: {}, error: null });

    const busy = await reconcileAttachedSessionBusyState("session-1");

    expect(busy).toBe(false);
    expect(attachManager.isAttached()).toBe(false);
    expect(mocked.getActiveSessionsMock).not.toHaveBeenCalled();
  });

  it("clears stale busy flag when OpenCode reports the session idle", async () => {
    attachManager.attach("session-1", "/Users/michael");
    attachManager.markBusy("session-1");

    mocked.getActiveSessionsMock.mockResolvedValue({
      data: {},
      error: null,
    });

    const busy = await reconcileAttachedSessionBusyState("session-1");

    expect(busy).toBe(false);
    expect(attachManager.isBusy()).toBe(false);
    expect(attachManager.getSnapshot()).toMatchObject({
      sessionId: "session-1",
      busy: false,
    });
  });

  it("sets busy flag when OpenCode reports the session running", async () => {
    attachManager.attach("session-1", "/Users/michael");

    mocked.getActiveSessionsMock.mockResolvedValue({
      data: { "session-1": { type: "running" } },
      error: null,
    });

    const busy = await reconcileAttachedSessionBusyState("session-1");

    expect(busy).toBe(true);
    expect(attachManager.isBusy()).toBe(true);
  });

  it("keeps current busy state when OpenCode status call fails", async () => {
    attachManager.attach("session-1", "/Users/michael");
    attachManager.markBusy("session-1");

    mocked.getActiveSessionsMock.mockResolvedValue({
      data: undefined,
      error: new Error("network down"),
    });

    const busy = await reconcileAttachedSessionBusyState("session-1");

    expect(busy).toBe(true);
    expect(attachManager.isBusy()).toBe(true);
    expect(mocked.getActiveSessionsMock).toHaveBeenCalledTimes(1);
  });

  it("does not change state for a different session id", async () => {
    attachManager.attach("session-1", "/Users/michael");
    attachManager.markBusy("session-1");

    mocked.getActiveSessionsMock.mockResolvedValue({
      data: {},
      error: null,
    });

    const busy = await reconcileAttachedSessionBusyState("session-other");

    expect(busy).toBe(false);
    expect(attachManager.isBusy()).toBe(true);
    expect(mocked.getActiveSessionsMock).not.toHaveBeenCalled();
  });
});

describe("attach/service reconcileForegroundSessionBusyState", () => {
  beforeEach(() => {
    foregroundSessionState.__resetForTests();
    mocked.getActiveSessionsMock.mockReset();
  });

  it("does nothing and skips status call when nothing is busy", async () => {
    mocked.getActiveSessionsMock.mockResolvedValue({ data: {}, error: null });

    await reconcileForegroundSessionBusyState();

    expect(foregroundSessionState.isBusy()).toBe(false);
    expect(mocked.getActiveSessionsMock).not.toHaveBeenCalled();
  });

  it("clears a stale foreground busy flag when OpenCode reports the session idle", async () => {
    foregroundSessionState.markBusy("session-fg");

    mocked.getActiveSessionsMock.mockResolvedValue({
      data: { "session-fg": { type: "idle" } },
      error: null,
    });

    await reconcileForegroundSessionBusyState();

    expect(foregroundSessionState.isBusy()).toBe(false);
  });

  it("keeps the foreground busy flag while OpenCode reports the session running", async () => {
    foregroundSessionState.markBusy("session-fg");

    mocked.getActiveSessionsMock.mockResolvedValue({
      data: { "session-fg": { type: "running" } },
      error: null,
    });

    await reconcileForegroundSessionBusyState();

    expect(foregroundSessionState.isBusy()).toBe(true);
  });

  it("clears only the sessions OpenCode reports idle and keeps running ones", async () => {
    foregroundSessionState.markBusy("session-stale");
    foregroundSessionState.markBusy("session-running");

    mocked.getActiveSessionsMock.mockResolvedValue({
      data: {
        "session-stale": { type: "idle" },
        "session-running": { type: "running" },
      },
      error: null,
    });

    await reconcileForegroundSessionBusyState();

    expect(foregroundSessionState.getActiveSessionIds()).toEqual(["session-running"]);
  });

  it("keeps current busy state when the status call fails", async () => {
    foregroundSessionState.markBusy("session-fg");

    mocked.getActiveSessionsMock.mockResolvedValue({
      data: undefined,
      error: new Error("network down"),
    });

    await reconcileForegroundSessionBusyState();

    expect(foregroundSessionState.isBusy()).toBe(true);
    expect(mocked.getActiveSessionsMock).toHaveBeenCalledTimes(1);
  });
});
