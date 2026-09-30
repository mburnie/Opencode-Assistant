import { execFile } from "node:child_process";

// Paths whose uncommitted changes mean the running code may not match the commit.
const SOURCE_PATHS = ["src", "package.json", "package-lock.json", "tsconfig.json"];

export interface GitRevision {
  sha: string;
  hasUncommittedSourceChanges: boolean;
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (error, output) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(String(output));
    });
  });
}

/**
 * Short commit SHA of the checkout at `cwd`, or null when it is not a git
 * checkout (e.g. an npm or Docker install without `.git`).
 */
export async function getGitRevision(cwd: string): Promise<GitRevision | null> {
  try {
    const sha = (await runGit(cwd, ["rev-parse", "--short", "HEAD"])).trim();
    const status = await runGit(cwd, [
      "status",
      "--porcelain",
      "--untracked-files=no",
      "--",
      ...SOURCE_PATHS,
    ]);

    return { sha, hasUncommittedSourceChanges: status.trim().length > 0 };
  } catch {
    return null;
  }
}

export function formatGitRevision(revision: GitRevision | null): string {
  if (!revision) {
    return "commit unknown";
  }

  return revision.hasUncommittedSourceChanges
    ? `commit ${revision.sha}, uncommitted source changes`
    : `commit ${revision.sha}`;
}
