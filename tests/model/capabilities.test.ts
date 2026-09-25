import { describe, expect, it } from "vitest";
import {
  supportsInput,
  supportsAttachment,
  type ModelCapabilities,
} from "../../src/model/capabilities.js";

describe("model/capabilities", () => {
  describe("supportsInput", () => {
    it("returns true when model supports image input", () => {
      const capabilities: ModelCapabilities = {
        tools: true,
        input: ["text", "image"],
        output: ["text"],
      };

      expect(supportsInput(capabilities, "image")).toBe(true);
    });

    it("returns false when model does not support image input", () => {
      const capabilities: ModelCapabilities = {
        tools: true,
        input: ["text"],
        output: ["text"],
      };

      expect(supportsInput(capabilities, "image")).toBe(false);
    });

    it("returns true when model supports PDF input", () => {
      const capabilities: ModelCapabilities = {
        tools: true,
        input: ["text", "image", "pdf"],
        output: ["text"],
      };

      expect(supportsInput(capabilities, "pdf")).toBe(true);
    });

    it("returns false when capabilities is null", () => {
      expect(supportsInput(null, "image")).toBe(false);
      expect(supportsInput(null, "pdf")).toBe(false);
      expect(supportsInput(null, "audio")).toBe(false);
      expect(supportsInput(null, "video")).toBe(false);
    });

    it("checks all input types", () => {
      const capabilities: ModelCapabilities = {
        tools: true,
        input: ["text", "audio", "image", "video", "pdf"],
        output: ["text"],
      };

      expect(supportsInput(capabilities, "image")).toBe(true);
      expect(supportsInput(capabilities, "pdf")).toBe(true);
      expect(supportsInput(capabilities, "audio")).toBe(true);
      expect(supportsInput(capabilities, "video")).toBe(true);
    });
  });

  describe("supportsAttachment", () => {
    it("returns true when model supports attachments", () => {
      const capabilities: ModelCapabilities = {
        tools: true,
        input: ["text", "image", "pdf"],
        output: ["text"],
      };

      expect(supportsAttachment(capabilities)).toBe(true);
    });

    it("returns false when model does not support attachments", () => {
      const capabilities: ModelCapabilities = {
        tools: true,
        input: ["text"],
        output: ["text"],
      };

      expect(supportsAttachment(capabilities)).toBe(false);
    });

    it("returns false when capabilities is null", () => {
      expect(supportsAttachment(null)).toBe(false);
    });
  });
});
