import { beforeEach, describe, expect, it } from "vitest";
import { formManager } from "../../src/form/manager.js";
import type { FormInfo } from "@opencode/client/promise";

const SAMPLE_FORM: FormInfo = {
  id: "frm_test_1",
  sessionID: "sess_1",
  title: "Test Form",
  fields: [
    {
      key: "choice",
      type: "string",
      title: "Choose one",
      description: "Pick an option",
      options: [
        { value: "a", label: "Alpha", description: "First" },
        { value: "b", label: "Beta", description: "Second" },
      ],
      required: true,
    },
    {
      key: "multi",
      type: "multiselect",
      title: "Choose many",
      options: [
        { value: "x", label: "X", description: "Ex" },
        { value: "y", label: "Y", description: "Why" },
      ],
      required: true,
    },
    {
      key: "free",
      type: "string",
      title: "Free text",
      required: false,
    },
    {
      key: "flag",
      type: "boolean",
      title: "Enable feature",
      required: true,
    },
  ],
};

describe("form/manager", () => {
  beforeEach(() => {
    formManager.clear();
  });

  it("starts a form and tracks metadata", () => {
    formManager.startForm(SAMPLE_FORM);

    expect(formManager.isActive()).toBe(true);
    expect(formManager.getFormId()).toBe("frm_test_1");
    expect(formManager.getSessionID()).toBe("sess_1");
    expect(formManager.getTotalFields()).toBe(4);
    expect(formManager.getCurrentFieldIndex()).toBe(0);
  });

  it("selects a single option for string field with options", () => {
    formManager.startForm(SAMPLE_FORM);

    formManager.selectOption(0, 1);

    expect(formManager.getSelectedOptions(0)).toEqual(new Set([1]));
    expect(formManager.getSelectedAnswer(0)).toBe("b");
  });

  it("toggles multiple options for multiselect field", () => {
    formManager.startForm(SAMPLE_FORM);

    formManager.selectOption(1, 0);
    formManager.selectOption(1, 1);

    expect(formManager.getSelectedOptions(1)).toEqual(new Set([0, 1]));
    expect(formManager.getSelectedAnswer(1)).toEqual(["x", "y"]);

    formManager.selectOption(1, 0);
    expect(formManager.getSelectedAnswer(1)).toEqual(["y"]);
  });

  it("stores custom text answers", () => {
    formManager.startForm(SAMPLE_FORM);

    formManager.nextField();
    formManager.nextField();

    expect(formManager.getCurrentField()?.key).toBe("free");

    formManager.setAnswer("free", "custom value");
    expect(formManager.getAnswer("free")).toBe("custom value");
  });

  it("advances through fields", () => {
    formManager.startForm(SAMPLE_FORM);

    formManager.nextField();
    expect(formManager.getCurrentFieldIndex()).toBe(1);

    formManager.nextField();
    expect(formManager.getCurrentFieldIndex()).toBe(2);
  });

  it("collects all answers", () => {
    formManager.startForm(SAMPLE_FORM);

    formManager.selectOption(0, 0);
    formManager.nextField();

    formManager.selectOption(1, 1);
    formManager.nextField();

    formManager.setAnswer("free", "hello");
    formManager.nextField();

    formManager.setAnswer("flag", true);

    expect(formManager.getAllAnswers()).toEqual({
      choice: "a",
      multi: ["y"],
      free: "hello",
      flag: true,
    });
  });

  it("clears state", () => {
    formManager.startForm(SAMPLE_FORM);
    formManager.clear();

    expect(formManager.isActive()).toBe(false);
    expect(formManager.getFormId()).toBeNull();
    expect(formManager.getCurrentField()).toBeNull();
  });
});
