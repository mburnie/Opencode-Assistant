import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { formManager } from "../../../src/form/manager.js";
import { interactionManager } from "../../../src/interaction/manager.js";
import * as clientV2 from "../../../src/opencode/client-v2.js";
import {
  handleFormCallback,
  handleFormTextAnswer,
  showCurrentFormField,
} from "../../../src/bot/handlers/form.js";
import { t } from "../../../src/i18n/index.js";
import type { FormInfo } from "@opencode/client/promise";

const SINGLE_CHOICE_FORM: FormInfo = {
  id: "frm_single",
  sessionID: "sess_1",
  title: "Single choice",
  fields: [
    {
      key: "choice",
      type: "string",
      title: "Pick one",
      options: [
        { value: "a", label: "Alpha", description: "First option" },
        { value: "b", label: "Beta", description: "Second option" },
      ],
      required: true,
    },
  ],
};

const MULTI_FORM: FormInfo = {
  id: "frm_multi",
  sessionID: "sess_1",
  title: "Multi",
  fields: [
    {
      key: "items",
      type: "multiselect",
      title: "Pick items",
      options: [
        { value: "x", label: "X", description: "Ex" },
        { value: "y", label: "Y", description: "Why" },
      ],
      required: true,
    },
  ],
};

const TEXT_FORM: FormInfo = {
  id: "frm_text",
  sessionID: "sess_1",
  title: "Text",
  fields: [
    {
      key: "name",
      type: "string",
      title: "Your name",
      required: true,
    },
  ],
};

function createApi(sendMessageIds: number[]): Context["api"] {
  let index = 0;
  return {
    sendMessage: vi.fn().mockImplementation(async () => {
      const messageId = sendMessageIds[index] ?? sendMessageIds[sendMessageIds.length - 1] ?? 1;
      index += 1;
      return { message_id: messageId };
    }),
    deleteMessage: vi.fn().mockResolvedValue(true),
  } as unknown as Context["api"];
}

function createCallbackContext(data: string, messageId: number, api: Context["api"]): Context {
  return {
    chat: { id: 123 },
    callbackQuery: {
      data,
      message: { message_id: messageId },
    } as Context["callbackQuery"],
    api,
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

function createTextContext(text: string, api: Context["api"]): Context {
  return {
    chat: { id: 123 },
    message: { text } as Context["message"],
    api,
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

describe("bot/handlers/form", () => {
  let replyToFormSpy: ReturnType<typeof vi.spyOn>;
  let cancelFormSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    formManager.clear();
    interactionManager.clear("test_setup");
    replyToFormSpy = vi
      .spyOn(clientV2, "replyToForm")
      .mockResolvedValue({ error: undefined });
    cancelFormSpy = vi
      .spyOn(clientV2, "cancelForm")
      .mockResolvedValue({ error: undefined });
  });

  afterEach(() => {
    replyToFormSpy.mockRestore();
    cancelFormSpy.mockRestore();
  });

  it("starts form interaction when showing field", async () => {
    const api = createApi([100]);

    formManager.startForm(SINGLE_CHOICE_FORM);
    await showCurrentFormField(api, 123);

    expect(formManager.getActiveMessageId()).toBe(100);

    const state = interactionManager.getSnapshot();
    expect(state?.kind).toBe("form");
    expect(state?.expectedInput).toBe("callback");
    expect(state?.metadata.formID).toBe("frm_single");
    expect(state?.metadata.messageId).toBe(100);
  });

  it("selects single choice and submits form reply", async () => {
    const api = createApi([101]);

    formManager.startForm(SINGLE_CHOICE_FORM);
    await showCurrentFormField(api, 123);

    const selectCtx = createCallbackContext("form:sel:0:0", 101, api);
    const handled = await handleFormCallback(selectCtx);

    expect(handled).toBe(true);
    expect(replyToFormSpy).toHaveBeenCalledWith("sess_1", "frm_single", { choice: "a" });
  });

  it("requires at least one option on multiselect submit", async () => {
    const api = createApi([200]);

    formManager.startForm(MULTI_FORM);
    await showCurrentFormField(api, 123);

    const submitCtx = createCallbackContext("form:sub:0", 200, api);
    const handled = await handleFormCallback(submitCtx);

    expect(handled).toBe(true);
    expect(submitCtx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("form.select_one_required_callback"),
      show_alert: true,
    });
    expect(replyToFormSpy).not.toHaveBeenCalled();
  });

  it("submits multiselect after selecting options", async () => {
    const api = createApi([300]);

    formManager.startForm(MULTI_FORM);
    await showCurrentFormField(api, 123);

    await handleFormCallback(createCallbackContext("form:sel:0:0", 300, api));
    await handleFormCallback(createCallbackContext("form:sub:0", 300, api));

    expect(replyToFormSpy).toHaveBeenCalledWith("sess_1", "frm_multi", { items: ["x"] });
  });

  it("switches to mixed mode on custom callback and accepts text answer", async () => {
    const api = createApi([400, 401]);

    formManager.startForm(TEXT_FORM);
    await showCurrentFormField(api, 123);

    const customCtx = createCallbackContext("form:cst:0", 400, api);
    await handleFormCallback(customCtx);

    expect(formManager.isWaitingForCustomInput(0)).toBe(true);
    expect(interactionManager.getSnapshot()?.expectedInput).toBe("mixed");

    const textCtx = createTextContext("Alice", api);
    await handleFormTextAnswer(textCtx);

    expect(replyToFormSpy).toHaveBeenCalledWith("sess_1", "frm_text", { name: "Alice" });
    expect(api.deleteMessage).toHaveBeenCalledWith(123, 400);
  });

  it("rejects stale callback from old form message", async () => {
    const api = createApi([500]);

    formManager.startForm(SINGLE_CHOICE_FORM);
    await showCurrentFormField(api, 123);

    const staleCtx = createCallbackContext("form:sel:0:0", 499, api);
    const handled = await handleFormCallback(staleCtx);

    expect(handled).toBe(true);
    expect(staleCtx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("form.inactive_callback"),
      show_alert: true,
    });
  });

  it("cancels form and calls cancelForm", async () => {
    const api = createApi([600]);

    formManager.startForm(SINGLE_CHOICE_FORM);
    await showCurrentFormField(api, 123);

    const cancelCtx = createCallbackContext("form:cnl", 600, api);
    const handled = await handleFormCallback(cancelCtx);

    expect(handled).toBe(true);
    expect(cancelCtx.editMessageText).toHaveBeenCalledWith(t("form.cancelled"));
    expect(formManager.isActive()).toBe(false);
    expect(cancelFormSpy).toHaveBeenCalledWith("sess_1", "frm_single");
  });
});
