/**
 * Permission request from OpenCode (maps to SDK PermissionRequest)
 *
 * `permission` and `patterns` are optional-tolerant at runtime: V2 payloads
 * may omit them (e.g. memory MCP tool calls arrive without an action), so
 * consumers must not assume they are present.
 */
export interface PermissionRequest {
  id: string; // Request ID for reply
  sessionID: string;
  permission: string; // "bash", "edit", "webfetch", etc. May be "" when unknown.
  patterns: Array<string>; // Commands/files being requested. May be empty.
  metadata: { [key: string]: unknown }; // Additional context
  always: Array<string>; // Already approved patterns
  tool?: {
    messageID: string;
    callID: string;
  };
}

/**
 * Possible permission responses
 */
export type PermissionReply = "once" | "always" | "reject";

/**
 * State for active permission requests
 */
export interface PermissionState {
  requestsByMessageId: Map<number, PermissionRequest>; // Telegram message ID -> request
}
