import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("memory/manager backupMemory", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-backup-test-"));
    process.env.MEMORY_DIR = tempDir;
    // manager.ts resolves MEMORY_DIR at import time.
    vi.resetModules();
  });

  afterEach(async () => {
    const { closeDb } = await import("../../src/memory/db.js");
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.MEMORY_DIR;
  });

  // Regression (1 Oct 2026): the "backup" task only copied the legacy .md
  // files, so memory held in SQLite (facts, session summary, ...) was never
  // in the snapshot.
  it("includes the SQLite memory (facts and documents) in the snapshot", async () => {
    const { addFact } = await import("../../src/memory/repositories/facts.js");
    const { setDocument } = await import("../../src/memory/repositories/documents.js");
    const { backupMemory } = await import("../../src/memory/manager.js");

    addFact({ content: "likes teal", category: "preference" });
    setDocument("session-summary", "# Session Summary\nworked on backups");

    const backupPath = await backupMemory();
    const snapshot = path.join(backupPath, "data.db");
    expect(fs.existsSync(snapshot)).toBe(true);

    const db = new Database(snapshot, { readonly: true });
    try {
      expect(db.prepare("SELECT content FROM facts").all()).toEqual([{ content: "likes teal" }]);
      expect(
        db.prepare("SELECT content FROM documents WHERE name = 'session-summary'").get(),
      ).toEqual({ content: "# Session Summary\nworked on backups" });
    } finally {
      db.close();
    }
  });
});
