import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  serverInfoMock: vi.fn(),
  projectListMock: vi.fn(),
  sessionListMock: vi.fn(),
  sessionGetMock: vi.fn(),
  agentListMock: vi.fn(),
  providerListMock: vi.fn(),
  modelListMock: vi.fn(),
  sessionActiveMock: vi.fn(),
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
      server: {
        info: mocked.serverInfoMock,
      },
      project: {
        list: mocked.projectListMock,
      },
      session: {
        list: mocked.sessionListMock,
        get: mocked.sessionGetMock,
        active: mocked.sessionActiveMock,
      },
      agent: {
        list: mocked.agentListMock,
      },
      provider: {
        list: mocked.providerListMock,
      },
      model: {
        list: mocked.modelListMock,
      },
    })),
  },
}));

import {
  checkServerHealth,
  callOpenCode,
  listProjects,
  listSessions,
  getSession,
  listAgents,
  listProvidersWithModels,
  getActiveSessions,
} from "../../src/opencode/client-v2.js";

describe("opencode/client-v2", () => {
  beforeEach(() => {
    mocked.serverInfoMock.mockReset();
    mocked.projectListMock.mockReset();
    mocked.sessionListMock.mockReset();
    mocked.sessionGetMock.mockReset();
    mocked.agentListMock.mockReset();
    mocked.providerListMock.mockReset();
    mocked.modelListMock.mockReset();
    mocked.sessionActiveMock.mockReset();
  });

  it("returns healthy when server.info succeeds", async () => {
    mocked.serverInfoMock.mockResolvedValue({
      version: "2.0.11",
      pid: 123,
      urls: ["http://localhost:4096"],
      paths: { tmp: "/tmp" },
    });

    const result = await checkServerHealth();

    expect(result.healthy).toBe(true);
    expect(result.version).toBe("2.0.11");
    expect(result.error).toBeUndefined();
  });

  it("returns unhealthy when server.info throws", async () => {
    const error = new Error("offline");
    mocked.serverInfoMock.mockRejectedValue(error);

    const result = await checkServerHealth();

    expect(result.healthy).toBe(false);
    expect(result.error).toBe(error);
  });

  it("wraps a successful call in { data }", async () => {
    const value = { ok: true };
    const result = await callOpenCode(() => Promise.resolve(value));

    expect(result.data).toBe(value);
    expect(result.error).toBeUndefined();
  });

  it("wraps a failed call in { error }", async () => {
    const error = new Error("boom");
    const result = await callOpenCode(() => Promise.reject(error));

    expect(result.data).toBeUndefined();
    expect(result.error).toBe(error);
  });

  it("lists projects mapping canonical to worktree", async () => {
    mocked.projectListMock.mockResolvedValue([
      {
        id: "p1",
        canonical: "/repo/a",
        name: "Repo A",
        time: { updated: 1000 },
      },
    ]);

    const result = await listProjects();

    expect(result.data).toEqual([
      { id: "p1", worktree: "/repo/a", name: "Repo A", time: { updated: 1000 } },
    ]);
  });

  it("lists sessions with legacy shape", async () => {
    mocked.sessionListMock.mockResolvedValue({
      data: [
        {
          id: "s1",
          location: { directory: "/repo/a" },
          title: "Session 1",
          time: { created: 1, updated: 2 },
          parentID: undefined,
        },
      ],
      cursor: {},
    });

    const result = await listSessions({ directory: "/repo/a", limit: 10, roots: true });

    expect(mocked.sessionListMock).toHaveBeenCalledWith({
      directory: "/repo/a",
      limit: 10,
      order: undefined,
      parentID: null,
    });
    expect(result.data).toEqual([
      {
        id: "s1",
        directory: "/repo/a",
        title: "Session 1",
        time: { created: 1, updated: 2 },
        parentID: undefined,
      },
    ]);
  });

  it("gets a session by id", async () => {
    mocked.sessionGetMock.mockResolvedValue({
      id: "s1",
      location: { directory: "/repo/a" },
      title: "Session 1",
      time: { created: 1, updated: 2 },
    });

    const result = await getSession("s1");

    expect(mocked.sessionGetMock).toHaveBeenCalledWith({ sessionID: "s1" });
    expect(result.data?.id).toBe("s1");
    expect(result.data?.directory).toBe("/repo/a");
  });

  it("lists agents", async () => {
    mocked.agentListMock.mockResolvedValue({
      data: [
        { name: "build", mode: "primary", hidden: false },
        { name: "hidden-agent", mode: "primary", hidden: true },
      ],
      location: { directory: "/repo/a" },
    });

    const result = await listAgents("/repo/a");

    expect(mocked.agentListMock).toHaveBeenCalledWith({ location: { directory: "/repo/a" } });
    expect(result.data).toHaveLength(2);
  });

  it("lists providers with models grouped by provider", async () => {
    mocked.providerListMock.mockResolvedValue({
      data: [
        { id: "openai", name: "OpenAI", activation: "enabled" },
        { id: "anthropic", name: "Anthropic", activation: "enabled" },
      ],
      location: { directory: "/repo/a" },
    });
    mocked.modelListMock.mockResolvedValue({
      data: [
        { providerID: "openai", modelID: "gpt-4o", name: "GPT-4o" },
        { providerID: "openai", modelID: "gpt-3.5", name: "GPT-3.5" },
        { providerID: "anthropic", modelID: "claude", name: "Claude" },
      ],
      location: { directory: "/repo/a" },
    });

    const result = await listProvidersWithModels("/repo/a");

    expect(result.data).toHaveLength(2);
    expect(Object.keys(result.data?.[0].models ?? {})).toEqual(["gpt-4o", "gpt-3.5"]);
    expect(Object.keys(result.data?.[1].models ?? {})).toEqual(["claude"]);
  });

  it("returns active sessions", async () => {
    mocked.sessionActiveMock.mockResolvedValue({ "session-1": { type: "running" } });

    const result = await getActiveSessions();

    expect(result.data).toEqual({ "session-1": { type: "running" } });
  });
});
