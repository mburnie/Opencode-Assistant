import { beforeEach, describe, expect, it } from "vitest";
import { clearAllInteractionState } from "../../src/interaction/cleanup.js";
import { interactionManager } from "../../src/interaction/manager.js";
import { permissionManager } from "../../src/permission/manager.js";
import { renameManager } from "../../src/rename/manager.js";
import type { PermissionRequest } from "../../src/permission/types.js";

const TEST_PERMISSION: PermissionRequest = {
  id: "perm-1",
  sessionID: "session-1",
  permission: "bash",
  patterns: ["npm test"],
  metadata: {},
  always: [],
};

describe("interaction/cleanup", () => {
  beforeEach(() => {
    clearAllInteractionState("test_setup");
  });

  it("clears all interaction-related managers", () => {
    permissionManager.startPermission(TEST_PERMISSION, 101);
    renameManager.startWaiting("session-1", "D:/repo", "Old title");
    interactionManager.start({
      kind: "rename",
      expectedInput: "text",
      metadata: { sessionId: "session-1" },
    });

    clearAllInteractionState("test_cleanup");

    expect(permissionManager.isActive()).toBe(false);
    expect(renameManager.isWaitingForName()).toBe(false);
    expect(interactionManager.getSnapshot()).toBeNull();
  });

  it("allows starting new interaction after cleanup", () => {
    interactionManager.start({
      kind: "inline",
      expectedInput: "callback",
      metadata: { menuKind: "model", messageId: 1 },
    });

    clearAllInteractionState("first_cleanup");

    interactionManager.start({
      kind: "form",
      expectedInput: "callback",
      metadata: { formID: "f-1" },
    });

    expect(interactionManager.getSnapshot()?.kind).toBe("form");
  });
});
