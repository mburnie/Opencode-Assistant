import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  providersMock,
  getSessionMock,
  switchSessionModelMock,
  loggerInfoMock,
  loggerWarnMock,
  loggerErrorMock,
  loggerDebugMock,
} = vi.hoisted(() => ({
  providersMock: vi.fn(),
  getSessionMock: vi.fn(),
  switchSessionModelMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerDebugMock: vi.fn(),
}));

vi.mock("../../src/opencode/client-v2.js", () => ({
  listProvidersWithModels: providersMock,
  getSession: getSessionMock,
  switchSessionModel: switchSessionModelMock,
}));

vi.mock("../../src/utils/logger.js", () => ({
  logger: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: loggerErrorMock,
    debug: loggerDebugMock,
  },
}));

import {
  __resetFreeModelCacheForTests,
  __resetModelCatalogCacheForTests,
  fetchSessionModel,
  getFavoriteModels,
  getModelSelectionLists,
  isFreeModel,
  requireSessionModel,
  SessionModelUnavailableError,
  setSessionModel,
} from "../../src/model/manager.js";

function createProvidersResponse(modelsByProvider: Record<string, string[]>) {
  return {
    data: Object.entries(modelsByProvider).map(([providerID, modelIDs]) => ({
      id: providerID,
      name: providerID,
      activation: "enabled" as const,
      models: Object.fromEntries(
        modelIDs.map((modelID) => [modelID, { modelID, name: modelID }] as const),
      ),
    })),
    error: null,
  };
}

describe("model/manager", () => {
  let tempDir = "";
  let originalXdgStateHome: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalXdgStateHome = process.env.XDG_STATE_HOME;
    originalHome = process.env.HOME;

    vi.useRealTimers();
    __resetModelCatalogCacheForTests();
    __resetFreeModelCacheForTests();

    loggerInfoMock.mockReset();
    loggerWarnMock.mockReset();
    loggerErrorMock.mockReset();
    loggerDebugMock.mockReset();

    getSessionMock.mockReset();
    switchSessionModelMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { id: "s1" }, error: null });
    switchSessionModelMock.mockResolvedValue({ error: null });

    providersMock.mockReset();
    providersMock.mockResolvedValue(
      createProvidersResponse({
        opencode: ["big-pickle"],
        openai: ["gpt-4o", "gpt-3.5"],
        anthropic: ["claude-sonnet"],
        google: ["gemini-pro"],
      }),
    );
  });

  afterEach(async () => {
    process.env.XDG_STATE_HOME = originalXdgStateHome;
    process.env.HOME = originalHome;
    vi.useRealTimers();

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  async function setupMockModelFile(content: object): Promise<string> {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "opencode-model-test-"));
    const opencodeDir = path.join(tempDir, "opencode");
    await mkdir(opencodeDir, { recursive: true });
    const modelFilePath = path.join(opencodeDir, "model.json");
    await writeFile(modelFilePath, JSON.stringify(content), "utf-8");
    process.env.XDG_STATE_HOME = tempDir;
    return modelFilePath;
  }

  describe("getModelSelectionLists", () => {
    it("returns favorites and recent from model.json", async () => {
      await setupMockModelFile({
        favorite: [
          { providerID: "openai", modelID: "gpt-4o" },
          { providerID: "anthropic", modelID: "claude-sonnet" },
        ],
        recent: [
          { providerID: "google", modelID: "gemini-pro" },
          { providerID: "openai", modelID: "gpt-3.5" },
        ],
      });

      const result = await getModelSelectionLists();

      expect(result.favorites).toHaveLength(2); // 2 from file, no config default
      expect(result.favorites).toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
      expect(result.favorites).toContainEqual({
        providerID: "anthropic",
        modelID: "claude-sonnet",
      });

      expect(result.recent).toHaveLength(2);
      expect(result.recent).toContainEqual({ providerID: "google", modelID: "gemini-pro" });
      expect(result.recent).toContainEqual({ providerID: "openai", modelID: "gpt-3.5" });
    });

    it("deduplicates models with same provider/model combination", async () => {
      await setupMockModelFile({
        favorite: [
          { providerID: "openai", modelID: "gpt-4o" },
          { providerID: "openai", modelID: "gpt-4o" }, // duplicate
          { providerID: "anthropic", modelID: "claude-sonnet" },
        ],
        recent: [],
      });

      const result = await getModelSelectionLists();

      expect(result.favorites).toHaveLength(2); // 2 unique from file, no config default
      const openaiGpt4oCount = result.favorites.filter(
        (m) => m.providerID === "openai" && m.modelID === "gpt-4o",
      ).length;
      expect(openaiGpt4oCount).toBe(1);
    });

    it("does not include recent models that are already in favorites", async () => {
      await setupMockModelFile({
        favorite: [
          { providerID: "openai", modelID: "gpt-4o" },
          { providerID: "anthropic", modelID: "claude-sonnet" },
        ],
        recent: [
          { providerID: "openai", modelID: "gpt-4o" }, // duplicate of favorite
          { providerID: "google", modelID: "gemini-pro" }, // unique
        ],
      });

      const result = await getModelSelectionLists();

      expect(result.favorites).toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
      expect(result.recent).not.toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
      expect(result.recent).toContainEqual({ providerID: "google", modelID: "gemini-pro" });
    });

    it("returns empty favorites when model.json does not exist", async () => {
      // Set XDG_STATE_HOME to a non-existent directory
      tempDir = await mkdtemp(path.join(os.tmpdir(), "opencode-model-test-"));
      process.env.XDG_STATE_HOME = path.join(tempDir, "nonexistent");

      const result = await getModelSelectionLists();

      expect(result.favorites).toHaveLength(0);
      expect(result.recent).toHaveLength(0);
    });

    it("handles missing recent array gracefully", async () => {
      await setupMockModelFile({
        favorite: [{ providerID: "openai", modelID: "gpt-4o" }],
        // no recent field
      });

      const result = await getModelSelectionLists();

      expect(result.favorites).toHaveLength(1); // 1 from file, no config default
      expect(result.recent).toHaveLength(0);
    });

    it("handles missing favorite array gracefully", async () => {
      await setupMockModelFile({
        // no favorite field
        recent: [{ providerID: "openai", modelID: "gpt-4o" }],
      });

      const result = await getModelSelectionLists();

      expect(result.favorites).toHaveLength(0);
      expect(result.recent).toHaveLength(1);
      expect(result.recent[0]).toEqual({ providerID: "openai", modelID: "gpt-4o" });
    });

    it("filters out invalid model entries with missing providerID", async () => {
      await setupMockModelFile({
        favorite: [
          { providerID: "openai", modelID: "gpt-4o" },
          { providerID: "", modelID: "invalid-model" },
          { modelID: "no-provider" }, // missing providerID
        ],
        recent: [],
      });

      const result = await getModelSelectionLists();

      expect(result.favorites).toHaveLength(1); // 1 valid from file
      expect(result.favorites).toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
    });

    it("filters out invalid model entries with missing modelID", async () => {
      await setupMockModelFile({
        favorite: [
          { providerID: "openai", modelID: "gpt-4o" },
          { providerID: "anthropic", modelID: "" },
          { providerID: "no-model" }, // missing modelID
        ],
        recent: [],
      });

      const result = await getModelSelectionLists();

      expect(result.favorites).toHaveLength(1); // 1 valid from file
      expect(result.favorites).toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
    });

    it("deduplicates recent models", async () => {
      await setupMockModelFile({
        favorite: [],
        recent: [
          { providerID: "openai", modelID: "gpt-4o" },
          { providerID: "openai", modelID: "gpt-4o" }, // duplicate
          { providerID: "google", modelID: "gemini-pro" },
        ],
      });

      const result = await getModelSelectionLists();

      expect(result.recent).toHaveLength(2);
      expect(result.recent).toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
      expect(result.recent).toContainEqual({ providerID: "google", modelID: "gemini-pro" });
    });

    it("filters out models that are not present in provider catalog", async () => {
      await setupMockModelFile({
        favorite: [
          { providerID: "openai", modelID: "gpt-4o" },
          { providerID: "openai", modelID: "missing-favorite" },
        ],
        recent: [
          { providerID: "google", modelID: "gemini-pro" },
          { providerID: "google", modelID: "missing-recent" },
        ],
      });

      const result = await getModelSelectionLists();

      expect(result.favorites).toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
      expect(result.favorites).not.toContainEqual({
        providerID: "openai",
        modelID: "missing-favorite",
      });

      expect(result.recent).toContainEqual({ providerID: "google", modelID: "gemini-pro" });
      expect(result.recent).not.toContainEqual({
        providerID: "google",
        modelID: "missing-recent",
      });
    });

    it("uses model catalog cache between repeated calls", async () => {
      await setupMockModelFile({
        favorite: [{ providerID: "openai", modelID: "gpt-4o" }],
        recent: [{ providerID: "google", modelID: "gemini-pro" }],
      });

      await getModelSelectionLists();
      await getModelSelectionLists();

      expect(providersMock).toHaveBeenCalledTimes(1);
    });

    it("falls back to stale model catalog cache when refresh fails", async () => {
      const startTime = new Date("2026-01-01T00:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(startTime);

      await setupMockModelFile({
        favorite: [
          { providerID: "openai", modelID: "gpt-4o" },
          { providerID: "openai", modelID: "retired" },
        ],
        recent: [{ providerID: "google", modelID: "gemini-pro" }],
      });

      const first = await getModelSelectionLists();
      expect(first.favorites).toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
      expect(first.favorites).not.toContainEqual({ providerID: "openai", modelID: "retired" });

      providersMock.mockResolvedValueOnce({ data: null, error: new Error("upstream unavailable") });
      vi.setSystemTime(new Date(startTime.getTime() + 11 * 60 * 1000));

      const second = await getModelSelectionLists();

      expect(providersMock).toHaveBeenCalledTimes(2);
      expect(second.favorites).toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
      expect(second.favorites).not.toContainEqual({ providerID: "openai", modelID: "retired" });
    });
  });

  describe("getFavoriteModels", () => {
    it("returns only favorites from getModelSelectionLists", async () => {
      await setupMockModelFile({
        favorite: [{ providerID: "openai", modelID: "gpt-4o" }],
        recent: [{ providerID: "google", modelID: "gemini-pro" }],
      });

      const favorites = await getFavoriteModels();

      expect(favorites).toHaveLength(1); // 1 from file, no config default
      expect(favorites).toContainEqual({ providerID: "openai", modelID: "gpt-4o" });
      // recent models should not be in favorites
      expect(favorites).not.toContainEqual({ providerID: "google", modelID: "gemini-pro" });
    });
  });

  describe("fetchSessionModel / requireSessionModel", () => {
    it("returns the session's model when present", async () => {
      getSessionMock.mockResolvedValue({
        data: {
          id: "s1",
          model: { providerID: "opencode-go", modelID: "deepseek-v4.1-flash", variant: "default" },
        },
        error: null,
      });

      expect(await fetchSessionModel("s1")).toEqual({
        providerID: "opencode-go",
        modelID: "deepseek-v4.1-flash",
        variant: "default",
      });
    });

    it("returns null when the session has no model", async () => {
      getSessionMock.mockResolvedValue({ data: { id: "s1" }, error: null });
      expect(await fetchSessionModel("s1")).toBeNull();
    });

    it("returns null when the session request fails", async () => {
      getSessionMock.mockResolvedValue({ error: new Error("not found") });
      expect(await fetchSessionModel("s1")).toBeNull();
    });

    it("requireSessionModel throws a clear error instead of falling back", async () => {
      getSessionMock.mockResolvedValue({ data: { id: "s1" }, error: null });
      await expect(requireSessionModel("s1")).rejects.toBeInstanceOf(
        SessionModelUnavailableError,
      );
    });

    it("requireSessionModel returns the model when resolvable", async () => {
      getSessionMock.mockResolvedValue({
        data: { id: "s1", model: { providerID: "opencode", modelID: "big-pickle" } },
        error: null,
      });
      await expect(requireSessionModel("s1")).resolves.toEqual({
        providerID: "opencode",
        modelID: "big-pickle",
        variant: undefined,
      });
    });
  });

  describe("setSessionModel", () => {
    it("switches the model on the OpenCode session", async () => {
      await setSessionModel("s1", {
        providerID: "openai",
        modelID: "gpt-5",
        variant: "default",
      });

      expect(switchSessionModelMock).toHaveBeenCalledWith("s1", {
        providerID: "openai",
        modelID: "gpt-5",
        variant: "default",
      });
    });
  });

  describe("isFreeModel", () => {
    function createProvidersResponseWithCost(
      modelsByProvider: Record<string, Array<{ id: string; cost?: unknown[] }>>,
    ) {
      return {
        data: Object.entries(modelsByProvider).map(([providerID, models]) => ({
          id: providerID,
          name: providerID,
          activation: "enabled" as const,
          models: Object.fromEntries(
            models.map((model) => [
              model.id,
              {
                modelID: model.id,
                name: model.id,
                cost: model.cost,
                status: "active",
              },
            ]),
          ),
        })),
        error: null,
      };
    }

    it("returns true for a model with all-zero cost tiers", async () => {
      providersMock.mockResolvedValue(
        createProvidersResponseWithCost({
          opencode: [
            {
              id: "big-pickle",
              cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
            },
          ],
        }),
      );

      expect(await isFreeModel("opencode", "big-pickle")).toBe(true);
    });

    it("returns false for a model with a non-zero cost tier", async () => {
      providersMock.mockResolvedValue(
        createProvidersResponseWithCost({
          openai: [
            {
              id: "gpt-5",
              cost: [
                {
                  input: 1.25,
                  output: 10,
                  cache: { read: 0.25, write: 1.5 },
                },
              ],
            },
          ],
        }),
      );

      expect(await isFreeModel("openai", "gpt-5")).toBe(false);
    });

    it("returns false for models without cost metadata", async () => {
      providersMock.mockResolvedValue(
        createProvidersResponseWithCost({
          anthropic: [{ id: "claude-sonnet", cost: undefined }],
        }),
      );

      expect(await isFreeModel("anthropic", "claude-sonnet")).toBe(false);
    });

    it("returns false when the catalog is unavailable", async () => {
      providersMock.mockResolvedValue({ data: null, error: new Error("server down") });

      expect(await isFreeModel("opencode", "big-pickle")).toBe(false);
    });

    it("returns false for unknown models", async () => {
      providersMock.mockResolvedValue(
        createProvidersResponseWithCost({
          opencode: [{ id: "big-pickle" }],
        }),
      );

      expect(await isFreeModel("opencode", "no-such-model")).toBe(false);
    });
  });
});
