import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  formListMock: vi.fn(),
  formGetMock: vi.fn(),
  formReplyMock: vi.fn(),
  formCancelMock: vi.fn(),
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
      session: {
        form: {
          list: mocked.formListMock,
          get: mocked.formGetMock,
          reply: mocked.formReplyMock,
          cancel: mocked.formCancelMock,
        },
      },
    })),
  },
}));

import {
  cancelForm,
  getSessionForm,
  listSessionForms,
  replyToForm,
} from "../../src/opencode/client-v2.js";

describe("opencode/client-v2 form helpers", () => {
  beforeEach(() => {
    mocked.formListMock.mockReset();
    mocked.formGetMock.mockReset();
    mocked.formReplyMock.mockReset().mockResolvedValue(undefined);
    mocked.formCancelMock.mockReset().mockResolvedValue(undefined);
  });

  it("lists forms for a session", async () => {
    const forms = [{ id: "frm_1", sessionID: "sess_1", fields: [] }];
    mocked.formListMock.mockResolvedValue(forms);

    const result = await listSessionForms("sess_1");

    expect(result).toEqual({ data: forms });
    expect(mocked.formListMock).toHaveBeenCalledWith({ sessionID: "sess_1" });
  });

  it("gets a form by session and form ID", async () => {
    const detail = {
      form: { id: "frm_1", sessionID: "sess_1", fields: [] },
      state: { status: "pending" },
    };
    mocked.formGetMock.mockResolvedValue(detail);

    const result = await getSessionForm("sess_1", "frm_1");

    expect(result).toEqual({ data: detail });
    expect(mocked.formGetMock).toHaveBeenCalledWith({
      sessionID: "sess_1",
      formID: "frm_1",
    });
  });

  it("calls session.form.reply with the provided answer map", async () => {
    const answer = {
      choice: "a",
      multi: ["x", "y"],
      flag: true,
      count: 42,
    };

    const result = await replyToForm("sess_1", "frm_1", answer);

    expect(result.error).toBeUndefined();
    expect(mocked.formReplyMock).toHaveBeenCalledTimes(1);
    expect(mocked.formReplyMock).toHaveBeenCalledWith({
      sessionID: "sess_1",
      formID: "frm_1",
      answer,
    });
  });

  it("returns error when session.form.reply throws", async () => {
    mocked.formReplyMock.mockRejectedValue(new Error("network error"));

    const result = await replyToForm("sess_1", "frm_1", { name: "test" });

    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe("network error");
  });

  it("calls session.form.cancel", async () => {
    const result = await cancelForm("sess_1", "frm_1");

    expect(result.error).toBeUndefined();
    expect(mocked.formCancelMock).toHaveBeenCalledTimes(1);
    expect(mocked.formCancelMock).toHaveBeenCalledWith({
      sessionID: "sess_1",
      formID: "frm_1",
    });
  });
});
