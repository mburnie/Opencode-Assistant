import type { SessionMessageInfo, TokenUsageInfo } from "@opencode/client/promise";
import { callOpenCode, opencodeClientV2 } from "./client-v2.js";

export interface LegacyMessagePart {
  type: string;
  text?: string;
  ignored?: boolean;
  tool?: string;
  state?: {
    status: string;
    input?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
}

export interface LegacyMessageInfo {
  role: string;
  agent?: string;
  time?: { created?: number; completed?: number };
  summary?: boolean;
  tokens?: { input: number; cache?: { read: number } };
  cost?: number;
  error?: unknown;
}

export interface LegacyMessage {
  info: LegacyMessageInfo;
  parts: LegacyMessagePart[];
}

function convertTokens(tokens: TokenUsageInfo | undefined): LegacyMessageInfo["tokens"] {
  if (!tokens) {
    return undefined;
  }

  return {
    input: tokens.input,
    cache: { read: tokens.cache.read },
  };
}

function convertCost(cost: number | undefined): number | undefined {
  return cost;
}

export function toLegacyMessage(message: SessionMessageInfo): LegacyMessage {
  switch (message.type) {
    case "user":
      return {
        info: { role: "user", time: message.time },
        parts: [{ type: "text", text: message.text }],
      };

    case "assistant": {
      const parts: LegacyMessagePart[] = message.content.map((part) => {
        if (part.type === "text") {
          return { type: "text", text: part.text };
        }

        if (part.type === "reasoning") {
          return { type: "reasoning", text: part.text };
        }

        return {
          type: "tool",
          tool: part.name,
          state: {
            status: part.state.status,
            input:
              typeof part.state.input === "object" && part.state.input !== null
                ? (part.state.input as Record<string, unknown>)
                : undefined,
            metadata:
              "metadata" in part.state && part.state.metadata
                ? (part.state.metadata as Record<string, unknown>)
                : undefined,
          },
        };
      });

      return {
        info: {
          role: "assistant",
          agent: message.agent,
          time: message.time,
          tokens: convertTokens(message.tokens),
          cost: convertCost(message.cost),
          error: message.error,
        },
        parts,
      };
    }

    case "synthetic":
      return {
        info: { role: "synthetic", time: message.time },
        parts: [{ type: "text", text: message.text }],
      };

    case "system":
      return {
        info: { role: "system", time: message.time },
        parts: [{ type: "text", text: message.text }],
      };

    case "skill":
      return {
        info: { role: "skill", time: message.time },
        parts: [{ type: "text", text: message.text }],
      };

    case "shell":
      return {
        info: { role: "shell", time: message.time },
        parts: [
          {
            type: "tool",
            tool: message.command,
            state: {
              status: message.status,
              metadata: message.exit !== undefined ? { exit: message.exit } : undefined,
            },
          },
        ],
      };

    case "compaction":
      return {
        info: {
          role: "assistant",
          time: message.time,
          summary: true,
          tokens: convertTokens("tokens" in message ? message.tokens : undefined),
          cost: convertCost("cost" in message ? message.cost : undefined),
          error: "error" in message ? message.error : undefined,
        },
        parts: [],
      };

    case "idle":
      return {
        info: {
          role: "assistant",
          time: message.time,
        },
        parts: [],
      };

    case "agent-switched":
    case "model-switched":
    case "location-switched":
      return {
        info: { role: message.type, time: message.time },
        parts: [],
      };

    default:
      return {
        info: { role: "unknown", time: (message as { time?: { created: number } }).time },
        parts: [],
      };
  }
}

export async function listMessages(params: {
  sessionID: string;
  directory?: string;
  limit?: number;
}): Promise<{ data?: LegacyMessage[]; error?: unknown }> {
  const { data, error } = await callOpenCode(() =>
    opencodeClientV2.message.list({
      sessionID: params.sessionID,
      limit: params.limit,
    }),
  );

  if (error || !data) {
    return { error };
  }

  return { data: data.data.map(toLegacyMessage) };
}

export async function getSessionMessage(
  sessionID: string,
  messageID: string,
): Promise<{ data?: LegacyMessage; error?: unknown }> {
  const { data, error } = await callOpenCode(() =>
    opencodeClientV2.session.message.get({ sessionID, messageID }),
  );

  if (error || !data) {
    return { error };
  }

  return { data: toLegacyMessage(data) };
}
