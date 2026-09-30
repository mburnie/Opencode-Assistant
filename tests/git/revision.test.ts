import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocked.execFileMock,
}));

import { formatGitRevision, getGitRevision } from "../../src/git/revision.js";

type ExecFileCallback = (error: Error | null, output: string) => void;

function mockGitOutputs(outputs: Record<string, string | Error>): void {
  mocked.execFileMock.mockImplementation(
    (_command: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
      const result = outputs[args[0]];
      if (result instanceof Error) {
        callback(result, "");
      } else {
        callback(null, result ?? "");
      }
    },
  );
}

describe("git/revision", () => {
  beforeEach(() => {
    mocked.execFileMock.mockReset();
  });

  it("returns the short SHA of a clean checkout", async () => {
    mockGitOutputs({ "rev-parse": "8a97cf3\n", status: "" });

    await expect(getGitRevision("/repo")).resolves.toEqual({
      sha: "8a97cf3",
      hasUncommittedSourceChanges: false,
    });
    expect(mocked.execFileMock).toHaveBeenCalledWith(
      "git",
      [
        "status",
        "--porcelain",
        "--untracked-files=no",
        "--",
        "src",
        "package.json",
        "package-lock.json",
        "tsconfig.json",
      ],
      expect.objectContaining({ cwd: "/repo" }),
      expect.any(Function),
    );
  });

  it("flags uncommitted source changes", async () => {
    mockGitOutputs({ "rev-parse": "8a97cf3\n", status: " M src/app/start-bot-app.ts\n" });

    await expect(getGitRevision("/repo")).resolves.toEqual({
      sha: "8a97cf3",
      hasUncommittedSourceChanges: true,
    });
  });

  it("returns null outside a git checkout", async () => {
    mockGitOutputs({ "rev-parse": new Error("not a git repository") });

    await expect(getGitRevision("/app")).resolves.toBeNull();
  });

  it("formats the revision for the startup log", () => {
    expect(formatGitRevision({ sha: "8a97cf3", hasUncommittedSourceChanges: false })).toBe(
      "commit 8a97cf3",
    );
    expect(formatGitRevision({ sha: "8a97cf3", hasUncommittedSourceChanges: true })).toBe(
      "commit 8a97cf3, uncommitted source changes",
    );
    expect(formatGitRevision(null)).toBe("commit unknown");
  });
});
