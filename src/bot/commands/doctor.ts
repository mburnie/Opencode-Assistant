import { CommandContext, Context } from "grammy";
import { checkServerHealth, getActiveSessions } from "../../opencode/client-v2.js";
import { getEventStreamStatus } from "../../opencode/events.js";
import { fetchSessionModel } from "../../model/manager.js";
import { getCurrentSession } from "../../session/manager.js";
import { getCurrentProject } from "../../settings/manager.js";
import { summaryAggregator } from "../../summary/aggregator.js";
import { formManager } from "../../form/manager.js";
import { interactionManager } from "../../interaction/manager.js";
import { foregroundSessionState } from "../../scheduled-task/foreground-state.js";
import { attachManager } from "../../attach/manager.js";
import { getDb } from "../../memory/db.js";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";

/**
 * /doctor — read-only health diagnostic. Every check only observes state:
 * nothing is restarted, cleared, repaired, or written.
 */

const CHECK_TIMEOUT_MS = 3000;
// The OpenCode v2 server sends an SSE keepalive every 15s; four missed
// keepalives means the stream is stalled even if the socket looks open.
export const EVENT_STREAM_STALL_MS = 60_000;

type PassFail = "PASS" | "FAIL";

export interface DoctorCheck<S extends string> {
  status: S;
  detail?: string;
}

export interface DoctorReport {
  telegram: DoctorCheck<PassFail>;
  opencode: DoctorCheck<PassFail>;
  model: DoctorCheck<PassFail | "UNKNOWN">;
  session: DoctorCheck<"IDLE" | "BUSY" | "UNKNOWN">;
  eventStream: DoctorCheck<PassFail | "UNKNOWN">;
  memoryMcp: DoctorCheck<PassFail>;
  memoryDb: DoctorCheck<PassFail>;
  pendingForm: DoctorCheck<"NONE" | "ACTIVE">;
  pendingInteraction: DoctorCheck<"NONE" | "ACTIVE">;
  busyState: DoctorCheck<"CLEAR" | "BUSY" | "INCONSISTENT">;
  lastTurnCompletion: DoctorCheck<string>;
  overall: "HEALTHY" | "DEGRADED" | "FAILED";
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (error && typeof error === "object" && "_tag" in error) {
    return String((error as { _tag: unknown })._tag);
  }
  return "unreachable";
}

function portOf(url: string, fallback: string): string {
  try {
    return new URL(url).port || fallback;
  } catch {
    return fallback;
  }
}

function formatAge(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

async function checkOpenCode(): Promise<DoctorCheck<PassFail>> {
  try {
    const { healthy, version, error } = await withTimeout(checkServerHealth(), "OpenCode");
    return healthy
      ? { status: "PASS", detail: version ? `v${version}` : undefined }
      : { status: "FAIL", detail: errorDetail(error) };
  } catch (error) {
    return { status: "FAIL", detail: errorDetail(error) };
  }
}

async function checkSession(
  sessionId: string | null,
  opencodeUp: boolean,
): Promise<DoctorCheck<"IDLE" | "BUSY" | "UNKNOWN">> {
  if (!opencodeUp) {
    return { status: "UNKNOWN", detail: "OpenCode unavailable" };
  }
  if (!sessionId) {
    return { status: "IDLE", detail: "no session" };
  }
  try {
    const { data, error } = await withTimeout(getActiveSessions(), "session status");
    if (error || !data) {
      return { status: "UNKNOWN", detail: errorDetail(error) };
    }
    return data[sessionId]?.type === "running" ? { status: "BUSY" } : { status: "IDLE" };
  } catch (error) {
    return { status: "UNKNOWN", detail: errorDetail(error) };
  }
}

async function checkModel(
  sessionId: string | null,
  opencodeUp: boolean,
): Promise<DoctorCheck<PassFail | "UNKNOWN">> {
  if (!opencodeUp) {
    return { status: "UNKNOWN", detail: "OpenCode unavailable" };
  }
  if (!sessionId) {
    return { status: "UNKNOWN", detail: "no session" };
  }
  try {
    const model = await withTimeout(fetchSessionModel(sessionId), "model");
    return model
      ? { status: "PASS", detail: `${model.providerID}/${model.modelID}` }
      : { status: "FAIL", detail: "session has no model" };
  } catch (error) {
    return { status: "UNKNOWN", detail: errorDetail(error) };
  }
}

function checkEventStream(
  projectDirectory: string | null,
  now: number,
): DoctorCheck<PassFail | "UNKNOWN"> {
  const stream = getEventStreamStatus();

  if (!stream.listening) {
    return projectDirectory
      ? { status: "FAIL", detail: "not subscribed" }
      : { status: "UNKNOWN", detail: "no project selected" };
  }
  if (!stream.connected) {
    return { status: "FAIL", detail: "reconnecting" };
  }
  if (projectDirectory && stream.directory !== projectDirectory) {
    // Events for the current project would be filtered out.
    return { status: "FAIL", detail: "subscribed to a different project" };
  }
  if (stream.lastActivityAt !== null && now - stream.lastActivityAt > EVENT_STREAM_STALL_MS) {
    return {
      status: "FAIL",
      detail: `stalled, no activity for ${formatAge(now - stream.lastActivityAt)}`,
    };
  }
  return { status: "PASS" };
}

async function checkMemoryMcp(): Promise<DoctorCheck<PassFail>> {
  if (!config.mcp.httpEnabled) {
    return { status: "FAIL", detail: "disabled" };
  }
  const host = ["0.0.0.0", "::", ""].includes(config.mcp.httpHost)
    ? "127.0.0.1"
    : config.mcp.httpHost;
  try {
    const response = await fetch(`http://${host}:${config.mcp.httpPort}/health`, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { status: "FAIL", detail: `HTTP ${response.status}` };
    }
    const body = (await response.json()) as { ok?: unknown };
    return body.ok === true ? { status: "PASS" } : { status: "FAIL", detail: "unhealthy response" };
  } catch (error) {
    return { status: "FAIL", detail: errorDetail(error) };
  }
}

function checkMemoryDb(): DoctorCheck<PassFail> {
  try {
    getDb().prepare("SELECT COUNT(*) AS n FROM facts").get();
    return { status: "PASS" };
  } catch (error) {
    return { status: "FAIL", detail: errorDetail(error) };
  }
}

function checkPendingForm(): DoctorCheck<"NONE" | "ACTIVE"> {
  return formManager.isActive() ? { status: "ACTIVE", detail: formManager.getFormId() ?? undefined } : { status: "NONE" };
}

function checkPendingInteraction(now: number): DoctorCheck<"NONE" | "ACTIVE"> {
  const state = interactionManager.getSnapshot();
  // An active form is reported on its own line.
  if (!state || (state.kind === "form" && formManager.isActive())) {
    return { status: "NONE" };
  }
  const expired = interactionManager.isExpired(now) ? ", expired" : "";
  return { status: "ACTIVE", detail: `${state.kind}, waiting for ${state.expectedInput}${expired}` };
}

function checkBusyState(
  session: DoctorCheck<"IDLE" | "BUSY" | "UNKNOWN">,
): DoctorCheck<"CLEAR" | "BUSY" | "INCONSISTENT"> {
  const localBusy = foregroundSessionState.isBusy() || attachManager.isBusy();

  if (session.status === "UNKNOWN") {
    return { status: localBusy ? "BUSY" : "CLEAR", detail: "not verified with OpenCode" };
  }

  const serverBusy = session.status === "BUSY";
  if (localBusy === serverBusy) {
    return { status: localBusy ? "BUSY" : "CLEAR" };
  }
  return {
    status: "INCONSISTENT",
    detail: localBusy ? "Leroy busy, OpenCode idle" : "OpenCode busy, Leroy idle",
  };
}

function checkLastTurnCompletion(): DoctorCheck<string> {
  const last = summaryAggregator.getLastTurnCompletion();
  return last ? { status: last.event } : { status: "UNKNOWN" };
}

export function computeOverall(report: Omit<DoctorReport, "overall">): DoctorReport["overall"] {
  const critical = [
    report.telegram.status,
    report.opencode.status,
    report.eventStream.status,
    report.memoryMcp.status,
    report.memoryDb.status,
  ];
  if (critical.includes("FAIL")) {
    return "FAILED";
  }

  const degraded =
    report.model.status !== "PASS" ||
    report.session.status === "UNKNOWN" ||
    report.eventStream.status === "UNKNOWN" ||
    report.pendingForm.status === "ACTIVE" ||
    report.pendingInteraction.status === "ACTIVE" ||
    report.busyState.status === "INCONSISTENT" ||
    report.lastTurnCompletion.status === "UNKNOWN";

  return degraded ? "DEGRADED" : "HEALTHY";
}

export async function collectDoctorReport(ctx: Context): Promise<DoctorReport> {
  const now = Date.now();
  const session = getCurrentSession();
  const sessionId = session?.id ?? null;
  const projectDirectory = getCurrentProject()?.worktree ?? null;

  const [opencode, memoryMcp] = await Promise.all([checkOpenCode(), checkMemoryMcp()]);
  const opencodeUp = opencode.status === "PASS";
  const [sessionCheck, model] = await Promise.all([
    checkSession(sessionId, opencodeUp),
    checkModel(sessionId, opencodeUp),
  ]);

  const partial: Omit<DoctorReport, "overall"> = {
    // The command was received and can be answered, so polling works; a known
    // bot identity confirms the Telegram API session is initialised.
    telegram: ctx.me?.id ? { status: "PASS" } : { status: "FAIL", detail: "bot identity unknown" },
    opencode,
    model,
    session: sessionCheck,
    eventStream: checkEventStream(projectDirectory, now),
    memoryMcp,
    memoryDb: checkMemoryDb(),
    pendingForm: checkPendingForm(),
    pendingInteraction: checkPendingInteraction(now),
    busyState: checkBusyState(sessionCheck),
    lastTurnCompletion: checkLastTurnCompletion(),
  };

  return { ...partial, overall: computeOverall(partial) };
}

function line(label: string, check: DoctorCheck<string>): string {
  return check.detail ? `${label}: ${check.status} (${check.detail})` : `${label}: ${check.status}`;
}

export function formatDoctorReport(report: DoctorReport): string {
  const opencodePort = portOf(config.opencode.apiUrl, "4096");
  return [
    "Leroy Health",
    "",
    line("Telegram", report.telegram),
    line(`OpenCode ${opencodePort}`, report.opencode),
    line("Model", report.model),
    line("Session", report.session),
    line("Event stream", report.eventStream),
    line(`Memory MCP ${config.mcp.httpPort}`, report.memoryMcp),
    line("Memory DB", report.memoryDb),
    line("Pending form", report.pendingForm),
    line("Pending menu/interaction", report.pendingInteraction),
    line("Busy state", report.busyState),
    line("Last turn completion", report.lastTurnCompletion),
    `Overall: ${report.overall}`,
  ].join("\n");
}

export async function doctorCommand(ctx: CommandContext<Context>): Promise<void> {
  try {
    const report = await collectDoctorReport(ctx);
    logger.info(`[Doctor] overall=${report.overall}`);
    // Plain text: details can contain characters Markdown would misparse.
    await ctx.reply(formatDoctorReport(report));
  } catch (error) {
    logger.error("[Doctor] Failed to build health report:", error);
    await ctx.reply(`Leroy Health\n\nOverall: FAILED (doctor error: ${errorDetail(error)})`);
  }
}
