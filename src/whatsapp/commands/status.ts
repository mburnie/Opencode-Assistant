import { checkServerHealth } from "../../opencode/client-v2.js";
import { getCurrentSession } from "../../session/manager.js";
import { getCurrentProject } from "../../settings/manager.js";
import { fetchCurrentAgent } from "../../agent/manager.js";
import { getAgentDisplayName } from "../../agent/types.js";
import { getSessionModelSafe } from "../../model/manager.js";
import { logger } from "../../utils/logger.js";
import type { WhatsAppCommandHandler } from "./types.js";

export const statusCommand: WhatsAppCommandHandler = async (ctx) => {
  try {
    const { healthy, version, error } = await checkServerHealth();

    if (error || !healthy) {
      await ctx.reply("⚠️ Server unavailable.");
      return;
    }

    const lines: string[] = [];
    lines.push("*Opencode-Assistant status*");
    lines.push("");
    lines.push("Health: ✅ healthy");
    if (version) {
      lines.push(`Version: ${version}`);
    }

    try {
      const agent = await fetchCurrentAgent();
      if (agent) {
        lines.push(`Agent: ${getAgentDisplayName(agent)}`);
      }
    } catch (err) {
      logger.debug("[WhatsApp][status] agent fetch failed", err);
    }

    const session = getCurrentSession("whatsapp");

    try {
      // Model must reflect the attached session; never a configured default.
      const model = session ? await getSessionModelSafe(session.id) : null;
      lines.push(`Model: ${model ? `${model.providerID}/${model.modelID}` : "unknown (no session model)"}`);
    } catch (err) {
      logger.debug("[WhatsApp][status] model fetch failed", err);
    }

    const project = getCurrentProject();
    if (project) {
      lines.push(`Project: ${project.worktree}`);
    } else {
      lines.push("Project: _not selected_");
    }

    if (session) {
      lines.push(`Session: ${session.title}`);
    } else {
      lines.push("Session: _none active_ (use /new)");
    }

    await ctx.reply(lines.join("\n"));
  } catch (err) {
    logger.error("[WhatsApp][status] error", err);
    await ctx.reply("Could not fetch server status.");
  }
};
