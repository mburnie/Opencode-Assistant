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

function makeV2FormEvent(
  type: "form.created" | "form.replied" | "form.cancelled",
  data: Record<string, unknown>,
): V2Event {
  return {
    id: "evt-1",
    created: Date.now(),
    type,
    data,
  } as V2Event;
}

describe("summary/aggregator form events", () => {
  beforeEach(() => {
    mocked.getCurrentProjectMock.mockReset();
    mocked.getCurrentProjectMock.mockReturnValue({ id: "p1", worktree: "/repo", name: "repo" });
    summaryAggregator.clear();
    summaryAggregator.setOnCleared(() => {});
  });

  it("invokes onForm callback for form.created matching current session", async () => {
    const onForm = vi.fn();
    summaryAggregator.setOnForm(onForm);
    summaryAggregator.setSession("sess_1");

    summaryAggregator.processEvent(
      makeV2FormEvent("form.created", {
        form: {
          id: "frm_1",
          sessionID: "sess_1",
          title: "Test form",
          fields: [{ key: "name", type: "string", title: "Name" }],
        },
      }),
    );

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onForm).toHaveBeenCalledTimes(1);
    expect(onForm).toHaveBeenCalledWith(
      expect.objectContaining({ id: "frm_1", sessionID: "sess_1" }),
      "sess_1",
    );
  });

  it("ignores form.created for a different session", () => {
    const onForm = vi.fn();
    summaryAggregator.setOnForm(onForm);
    summaryAggregator.setSession("sess_1");

    summaryAggregator.processEvent(
      makeV2FormEvent("form.created", {
        form: {
          id: "frm_2",
          sessionID: "sess_2",
          title: "Other form",
          fields: [{ key: "name", type: "string", title: "Name" }],
        },
      }),
    );

    expect(onForm).not.toHaveBeenCalled();
  });

  it("invokes onFormReplied callback for form.replied matching current session", async () => {
    const onFormReplied = vi.fn();
    summaryAggregator.setOnFormReplied(onFormReplied);
    summaryAggregator.setSession("sess_1");

    summaryAggregator.processEvent(
      makeV2FormEvent("form.replied", {
        id: "frm_1",
        sessionID: "sess_1",
      }),
    );

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onFormReplied).toHaveBeenCalledTimes(1);
    expect(onFormReplied).toHaveBeenCalledWith("frm_1", "sess_1");
  });

  it("invokes onFormCancelled callback for form.cancelled matching current session", async () => {
    const onFormCancelled = vi.fn();
    summaryAggregator.setOnFormCancelled(onFormCancelled);
    summaryAggregator.setSession("sess_1");

    summaryAggregator.processEvent(
      makeV2FormEvent("form.cancelled", {
        id: "frm_1",
        sessionID: "sess_1",
      }),
    );

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onFormCancelled).toHaveBeenCalledTimes(1);
    expect(onFormCancelled).toHaveBeenCalledWith("frm_1", "sess_1");
  });
});
