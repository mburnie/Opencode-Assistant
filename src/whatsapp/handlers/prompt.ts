import { promptSession } from "../../opencode/client-v2.js";
import { getCurrentSession } from "../../session/manager.js";
import { getCurrentProject } from "../../settings/manager.js";
import { injectMemoryIntoPrompt } from "../../memory/injector.js";
import { logger } from "../../utils/logger.js";
import type { WhatsAppCommandContext } from "../commands/types.js";

// Tracks whether a session is currently being prompted from WhatsApp so a
// second message from the same user doesn't fire a parallel prompt against
// the same session (OpenCode rejects concurrent prompts on a busy session).
const inFlightBySession = new Set<string>();

export async function handlePromptText(
  ctx: WhatsAppCommandContext,
  text: string,
): Promise<void> {
  const project = getCurrentProject();
  if (!project) {
    await ctx.reply(
      "No project selected. Open Telegram and pick one with /projects first.",
    );
    return;
  }

  const session = getCurrentSession("whatsapp");
  if (!session) {
    await ctx.reply("No active session. Send /new to start one.");
    return;
  }

  if (inFlightBySession.has(session.id)) {
    await ctx.reply("⏳ The previous task is still running. Send /abort to stop it.");
    return;
  }

  // Native WhatsApp "typing..." indicator instead of an ack message.
  // WhatsApp can't edit or delete our messages the way Telegram can, so any
  // status text we'd send ("Working on it...") would clutter the chat
  // permanently. Presence updates show in the chat header and disappear on
  // their own once we stop refreshing them, keeping the conversation clean.
  await ctx.bot.sendTyping(ctx.jid, "composing");

  inFlightBySession.add(session.id);

  try {
    const enrichedText = await injectMemoryIntoPrompt(text, session.id, { channel: "whatsapp" });

    const result = await promptSession({
      sessionID: session.id,
      text: enrichedText,
    });

    if (result.error) {
      logger.error("[WhatsApp][prompt] OpenCode error", result.error);
      await ctx.reply(
        "OpenCode returned an error. Check the bot logs or try again in a moment.",
      );
      return;
    }

    // The new SDK prompt endpoint only enqueues the user message; the assistant
    // reply arrives via the SSE event stream. WhatsApp currently has no event
    // subscription, so we cannot synchronously return the model response here.
    // Telegram-style event wiring would be needed for full WhatsApp responses.
    await ctx.reply(
      "✅ Message sent to OpenCode. WhatsApp replies require event subscription (not yet wired).",
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      await ctx.reply("Request was aborted.");
      return;
    }
    logger.error("[WhatsApp][prompt] unexpected error", err);
    await ctx.reply("Something went wrong while talking to the model. Try again.");
  } finally {
    inFlightBySession.delete(session.id);
    // Clear the typing hint regardless of outcome.
    await ctx.bot.sendTyping(ctx.jid, "paused");
  }
}
