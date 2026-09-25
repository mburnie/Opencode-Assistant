import { describe, expect, it } from "vitest";
import {
  getToolStreamKey,
  prepareDocumentCaption,
} from "../../src/bot/event-helpers.js";

describe("bot/event-helpers", () => {
  describe("prepareDocumentCaption", () => {
    it("returns empty string for whitespace-only input", () => {
      expect(prepareDocumentCaption("")).toBe("");
      expect(prepareDocumentCaption("   ")).toBe("");
      expect(prepareDocumentCaption("\n\t  ")).toBe("");
    });

    it("trims and returns short captions unchanged", () => {
      expect(prepareDocumentCaption("  hello world  ")).toBe("hello world");
    });

    it("preserves captions exactly at the Telegram caption limit (1024 chars)", () => {
      const exactLimit = "a".repeat(1024);
      expect(prepareDocumentCaption(exactLimit)).toBe(exactLimit);
    });

    it("truncates captions over 1024 chars and appends an ellipsis", () => {
      const longCaption = "a".repeat(2000);
      const result = prepareDocumentCaption(longCaption);
      expect(result.length).toBe(1024);
      expect(result.endsWith("...")).toBe(true);
      expect(result.slice(0, 1021)).toBe("a".repeat(1021));
    });
  });

  describe("getToolStreamKey", () => {
    it("returns 'todo' only for the todowrite tool", () => {
      expect(getToolStreamKey("todowrite")).toBe("todo");
    });

    it("returns 'default' for any other tool", () => {
      expect(getToolStreamKey("bash")).toBe("default");
      expect(getToolStreamKey("write")).toBe("default");
      expect(getToolStreamKey("edit")).toBe("default");
      expect(getToolStreamKey("read")).toBe("default");
      expect(getToolStreamKey("")).toBe("default");
    });
  });
});
