import { OpenCode } from "@opencode/client/promise";
import type {
  Project,
  SessionInfo,
  AgentInfo,
  ProviderInfo,
  ModelInfo,
  SessionListInput,
  AgentListInput,
  SessionCreateInput,
  SessionInterruptInput,
  SessionRemoveInput,
  SessionUpdateInput,
  SessionPromptInput,
  SessionCommandInput,
  SessionCompactInput,
  SessionInterruptResponse,
  SessionInboxUser,
  SessionGenerateInput,
  PermissionListInput,
  PermissionReplyInput,
  PermissionRequest as NewPermissionRequest,
  SessionFormListInput,
  SessionFormGetInput,
  SessionFormReplyInput,
  SessionFormCancelInput,
  FormInfo,
  FormDetail,
  CommandListInput,
  McpListInput,
  McpConnectInput,
  McpDisconnectInput,
  McpServer,
  CredentialUpdateInput,
  IntegrationOauthConnectInput,
} from "@opencode/client/promise";
import type { PermissionRequest as LegacyPermissionRequest } from "../permission/types.js";
import { config } from "../config.js";

function makeAuthHeader(): Record<string, string> | undefined {
  if (!config.opencode.password) {
    return undefined;
  }

  const credentials = `${config.opencode.username}:${config.opencode.password}`;
  return {
    Authorization: `Basic ${Buffer.from(credentials).toString("base64")}`,
  };
}

export const opencodeClientV2 = OpenCode.make({
  baseUrl: config.opencode.apiUrl,
  headers: makeAuthHeader(),
});

export async function callOpenCode<T>(
  fn: () => Promise<T>,
): Promise<{ data?: T; error?: unknown }> {
  try {
    return { data: await fn() };
  } catch (error) {
    return { error };
  }
}

export async function checkServerHealth(): Promise<{
  healthy: boolean;
  version?: string;
  error?: unknown;
}> {
  const { data, error } = await callOpenCode(() => opencodeClientV2.server.info());

  if (error || !data) {
    return { healthy: false, error };
  }

  return { healthy: true, version: data.version };
}

// ---------------------------------------------------------------------------
// Compatibility helpers that expose old SDK shapes over the new V2 client.
// ---------------------------------------------------------------------------

export interface ProjectListItem {
  id: string;
  worktree: string;
  name?: string;
  time?: { updated?: number };
}

function toProjectListItem(project: Project): ProjectListItem {
  return {
    id: project.id,
    worktree: project.canonical,
    name: project.name,
    time: { updated: project.time.updated },
  };
}

export async function listProjects(): Promise<{
  data?: ProjectListItem[];
  error?: unknown;
}> {
  const { data, error } = await callOpenCode(() => opencodeClientV2.project.list());

  if (error || !data) {
    return { error };
  }

  return { data: data.map(toProjectListItem) };
}

export interface SessionListItem {
  id: string;
  directory: string;
  title?: string;
  time: { created: number; updated: number };
  parentID?: string;
}

function toSessionListItem(session: SessionInfo): SessionListItem {
  return {
    id: session.id,
    directory: session.location.directory,
    title: session.title,
    time: session.time,
    parentID: session.parentID,
  };
}

export async function listSessions(params?: {
  directory?: string;
  limit?: number;
  order?: "asc" | "desc";
  roots?: boolean;
}): Promise<{ data?: SessionListItem[]; error?: unknown }> {
  const input: SessionListInput = {
    limit: params?.limit,
    order: params?.order,
    parentID: params?.roots ? null : undefined,
    directory: params?.directory,
  };

  const { data, error } = await callOpenCode(() => opencodeClientV2.session.list(input));

  if (error || !data) {
    return { error };
  }

  return { data: data.data.map(toSessionListItem) };
}

export async function getSession(
  sessionID: string,
): Promise<{ data?: SessionListItem; error?: unknown }> {
  const { data, error } = await callOpenCode(() =>
    opencodeClientV2.session.get({ sessionID }),
  );

  if (error || !data) {
    return { error };
  }

  return { data: toSessionListItem(data) };
}

export interface AgentListItem {
  name: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  hidden: boolean;
}

function toAgentListItem(agent: AgentInfo): AgentListItem {
  return {
    name: agent.id,
    description: agent.description,
    mode: agent.mode,
    hidden: agent.hidden,
  };
}

export async function listAgents(
  directory?: string,
): Promise<{ data?: AgentListItem[]; error?: unknown }> {
  const input: AgentListInput | undefined = directory ? { location: { directory } } : undefined;

  const { data, error } = await callOpenCode(() => opencodeClientV2.agent.list(input));

  if (error || !data) {
    return { error };
  }

  return { data: data.data.map(toAgentListItem) };
}

export interface ProviderWithModels {
  id: string;
  name: string;
  activation: "auto" | "enabled" | "disabled";
  integrationID?: string;
  models: Record<string, ModelInfo>;
}

export async function listProvidersWithModels(
  directory?: string,
): Promise<{ data?: ProviderWithModels[]; error?: unknown }> {
  const location = directory ? { location: { directory } } : undefined;

  const [
    { data: providersData, error: providersError },
    { data: modelsData, error: modelsError },
  ] = await Promise.all([
    callOpenCode(() => opencodeClientV2.provider.list(location)),
    callOpenCode(() => opencodeClientV2.model.list(location)),
  ]);

  if (providersError || modelsError) {
    return { error: providersError || modelsError };
  }

  if (!providersData || !modelsData) {
    return { error: new Error("No data received from server") };
  }

  const modelsByProvider = new Map<string, Map<string, ModelInfo>>();
  for (const model of modelsData.data) {
    if (!modelsByProvider.has(model.providerID)) {
      modelsByProvider.set(model.providerID, new Map());
    }
    modelsByProvider.get(model.providerID)!.set(model.modelID, model);
  }

  return {
    data: providersData.data.map((provider: ProviderInfo) => ({
      id: provider.id,
      name: provider.name,
      activation: provider.activation,
      integrationID: provider.integrationID,
      models: Object.fromEntries(modelsByProvider.get(provider.id) ?? new Map()),
    })),
  };
}

export async function getActiveSessions(): Promise<{
  data?: Record<string, { type: "running" }>;
  error?: unknown;
}> {
  const { data, error } = await callOpenCode(() => opencodeClientV2.session.active());

  if (error || !data) {
    return { error };
  }

  return { data };
}

// ---------------------------------------------------------------------------
// Mutating session helpers.
// ---------------------------------------------------------------------------

export interface LegacyFilePart {
  type: "file";
  url: string;
  filename?: string;
  mime?: string;
}

export interface LegacyTextPart {
  type: "text";
  text: string;
}

export type LegacyPromptPart = LegacyTextPart | LegacyFilePart;

export function toPromptFileAttachment(file: LegacyFilePart): {
  uri: string;
  name?: string;
  description?: string;
} {
  return {
    uri: file.url,
    name: file.filename,
    description: file.mime,
  };
}

export async function createSession(input: {
  directory: string;
  title?: string;
  agent?: string;
  model?: { providerID: string; modelID: string; variant?: string };
}): Promise<{ data?: SessionListItem; error?: unknown }> {
  const sessionInput: SessionCreateInput = {
    location: { directory: input.directory },
    title: input.title ?? null,
    agent: input.agent ?? null,
    model: input.model
      ? {
          id: input.model.modelID,
          providerID: input.model.providerID,
          variant: input.model.variant,
        }
      : null,
  };

  const { data, error } = await callOpenCode(() =>
    opencodeClientV2.session.create(sessionInput),
  );

  if (error || !data) {
    return { error };
  }

  return { data: toSessionListItem(data) };
}

export async function deleteSession(
  sessionID: string,
): Promise<{ error?: unknown }> {
  const input: SessionRemoveInput = { sessionID };
  const { error } = await callOpenCode(() => opencodeClientV2.session.remove(input));
  return { error };
}

export async function updateSession(
  sessionID: string,
  title: string,
): Promise<{ error?: unknown }> {
  const input: SessionUpdateInput = { sessionID, title };
  const { error } = await callOpenCode(() => opencodeClientV2.session.update(input));
  return { error };
}

export async function interruptSession(
  sessionID: string,
  resume?: boolean,
): Promise<{ data?: SessionInterruptResponse; error?: unknown }> {
  const input: SessionInterruptInput = { sessionID, resume };
  const { data, error } = await callOpenCode(() =>
    opencodeClientV2.session.interrupt(input),
  );

  if (error || !data) {
    return { error };
  }

  return { data };
}

async function switchSessionAgent(
  sessionID: string,
  agent: string,
): Promise<{ error?: unknown }> {
  const { error } = await callOpenCode(() =>
    opencodeClientV2.session.switchAgent({ sessionID, agent }),
  );
  return { error };
}

async function switchSessionModel(
  sessionID: string,
  model: { providerID: string; modelID: string; variant?: string },
): Promise<{ error?: unknown }> {
  const { error } = await callOpenCode(() =>
    opencodeClientV2.session.switchModel({
      sessionID,
      model: {
        id: model.modelID,
        providerID: model.providerID,
        variant: model.variant,
      },
    }),
  );
  return { error };
}

export async function promptSession(input: {
  sessionID: string;
  text: string;
  files?: LegacyFilePart[];
  agent?: string;
  model?: { providerID: string; modelID: string; variant?: string };
}): Promise<{ data?: SessionInboxUser; error?: unknown }> {
  if (input.agent) {
    const { error } = await switchSessionAgent(input.sessionID, input.agent);
    if (error) {
      return { error };
    }
  }

  if (input.model) {
    const { error } = await switchSessionModel(input.sessionID, input.model);
    if (error) {
      return { error };
    }
  }

  const promptInput: SessionPromptInput = {
    sessionID: input.sessionID,
    text: input.text,
    files: input.files?.map(toPromptFileAttachment),
  };

  const { data, error } = await callOpenCode(() =>
    opencodeClientV2.session.prompt(promptInput),
  );

  if (error || !data) {
    return { error };
  }

  return { data };
}

export async function commandSession(input: {
  sessionID: string;
  name: string;
  text: string;
  files?: LegacyFilePart[];
  agent?: string;
  model?: { providerID: string; modelID: string; variant?: string };
}): Promise<{ error?: unknown }> {
  if (input.agent) {
    const { error } = await switchSessionAgent(input.sessionID, input.agent);
    if (error) {
      return { error };
    }
  }

  if (input.model) {
    const { error } = await switchSessionModel(input.sessionID, input.model);
    if (error) {
      return { error };
    }
  }

  const commandInput: SessionCommandInput = {
    sessionID: input.sessionID,
    name: input.name,
    text: input.text,
    files: input.files?.map(toPromptFileAttachment),
  };

  const { error } = await callOpenCode(() =>
    opencodeClientV2.session.command(commandInput),
  );

  return { error };
}

export async function listCommands(
  directory?: string,
): Promise<{ data?: Array<{ name: string; description?: string }>; error?: unknown }> {
  const input: CommandListInput = directory ? { location: { directory } } : {};

  const { data, error } = await callOpenCode(() => opencodeClientV2.command.list(input));

  if (error || !data) {
    return { error };
  }

  return { data: data.data };
}

export async function generateSessionText(
  sessionID: string,
  prompt: string,
): Promise<{ data?: { text: string }; error?: unknown }> {
  const input: SessionGenerateInput = { sessionID, prompt };

  const { data, error } = await callOpenCode(() =>
    opencodeClientV2.session.generate(input),
  );

  if (error || !data) {
    return { error };
  }

  return { data };
}

export async function compactSession(
  sessionID: string,
): Promise<{ error?: unknown }> {
  const input: SessionCompactInput = { sessionID };

  const { error } = await callOpenCode(() =>
    opencodeClientV2.session.compact(input),
  );

  return { error };
}

export async function listPendingPermissions(
  sessionID: string,
): Promise<{ data?: NewPermissionRequest[]; error?: unknown }> {
  const input: PermissionListInput = { sessionID };

  const { data, error } = await callOpenCode(() =>
    opencodeClientV2.permission.list(input),
  );

  if (error || !data) {
    return { error };
  }

  return { data };
}

export async function replyToPermission(
  sessionID: string,
  requestID: string,
  decision: "once" | "always" | "reject",
  message?: string,
): Promise<{ error?: unknown }> {
  const input: PermissionReplyInput = {
    sessionID,
    requestID,
    decision,
    message,
  };

  const { error } = await callOpenCode(() =>
    opencodeClientV2.permission.reply(input),
  );

  return { error };
}

export function toLegacyPermissionRequest(
  request: NewPermissionRequest,
): LegacyPermissionRequest {
  return {
    id: request.id,
    sessionID: request.sessionID,
    permission: request.action,
    patterns: request.resources,
    metadata: (request.metadata ?? {}) as { [key: string]: unknown },
    always: (request.save ?? []) as string[],
  };
}

export async function listSessionForms(
  sessionID: string,
): Promise<{ data?: FormInfo[]; error?: unknown }> {
  const input: SessionFormListInput = { sessionID };
  const { data, error } = await callOpenCode(() =>
    opencodeClientV2.session.form.list(input),
  );

  if (error || !data) {
    return { error };
  }

  return { data };
}

export async function getSessionForm(
  sessionID: string,
  formID: string,
): Promise<{ data?: FormDetail; error?: unknown }> {
  const input: SessionFormGetInput = { sessionID, formID };
  const { data, error } = await callOpenCode(() =>
    opencodeClientV2.session.form.get(input),
  );

  if (error || !data) {
    return { error };
  }

  return { data };
}

export async function replyToForm(
  sessionID: string,
  formID: string,
  answer: Record<string, string | number | boolean | string[]>,
): Promise<{ error?: unknown }> {
  const input: SessionFormReplyInput = {
    sessionID,
    formID,
    answer,
  };

  const { error } = await callOpenCode(() =>
    opencodeClientV2.session.form.reply(input),
  );

  return { error };
}

export async function cancelForm(
  sessionID: string,
  formID: string,
): Promise<{ error?: unknown }> {
  const input: SessionFormCancelInput = {
    sessionID,
    formID,
  };

  const { error } = await callOpenCode(() =>
    opencodeClientV2.session.form.cancel(input),
  );

  return { error };
}

export async function listMcpServers(
  directory?: string,
): Promise<{ data?: McpServer[]; error?: unknown }> {
  const input: McpListInput = directory ? { location: { directory } } : {};

  const { data, error } = await callOpenCode(() => opencodeClientV2.mcp.list(input));

  if (error || !data) {
    return { error };
  }

  return { data: data.data };
}

export async function connectMcpServer(
  name: string,
  directory?: string,
): Promise<{ error?: unknown }> {
  const input: McpConnectInput = { server: name, location: directory ? { directory } : undefined };

  const { error } = await callOpenCode(() => opencodeClientV2.mcp.connect(input));
  return { error };
}

export async function disconnectMcpServer(
  name: string,
  directory?: string,
): Promise<{ error?: unknown }> {
  const input: McpDisconnectInput = { server: name, location: directory ? { directory } : undefined };

  const { error } = await callOpenCode(() => opencodeClientV2.mcp.disconnect(input));
  return { error };
}

// ---------------------------------------------------------------------------
// Provider auth helpers. The new SDK moved provider auth to integrations and
// credentials; these helpers preserve the old surface while we adapt.
// ---------------------------------------------------------------------------

export interface ProviderAuthMethod {
  type: "oauth" | "api" | "command" | "env";
  label?: string;
}

export async function getProviderAuthMethods(
  providerID: string,
): Promise<{ data?: ProviderAuthMethod[]; error?: unknown }> {
  const { data: providersData, error: providersError } = await listProvidersWithModels();

  if (providersError || !providersData) {
    return { error: providersError };
  }

  const provider = providersData.find((p) => p.id === providerID);
  const integrationID = provider?.integrationID;
  if (!integrationID) {
    return { data: [] };
  }

  const { data: integrationData, error: integrationError } = await callOpenCode(() =>
    opencodeClientV2.integration.get({ integrationID }),
  );

  if (integrationError || !integrationData) {
    return { error: integrationError };
  }

  return {
    data: integrationData.data.methods.map((method) => {
      if (method.type === "oauth") {
        return { type: "oauth", label: method.label };
      }
      if (method.type === "key") {
        return { type: "api", label: method.label };
      }
      if (method.type === "command") {
        return { type: "command", label: method.label };
      }
      return { type: "env", label: "Environment variables" };
    }),
  };
}

export async function setProviderApiKey(
  providerID: string,
  apiKey: string,
): Promise<{ error?: unknown }> {
  const { data: providersData, error: providersError } = await listProvidersWithModels();

  if (providersError || !providersData) {
    return { error: providersError };
  }

  const provider = providersData.find((p) => p.id === providerID);
  const integrationID = provider?.integrationID;
  if (!integrationID) {
    return { error: new Error(`Provider ${providerID} has no integration`) };
  }

  const { error } = await callOpenCode(() =>
    opencodeClientV2.integration.connect.key({
      integrationID,
      key: apiKey,
    }),
  );

  return { error };
}

export async function getProviderOAuthUrl(
  providerID: string,
  methodIndex = 0,
): Promise<{ data?: { url: string; instructions: string }; error?: unknown }> {
  const { data: providersData, error: providersError } = await listProvidersWithModels();

  if (providersError || !providersData) {
    return { error: providersError };
  }

  const provider = providersData.find((p) => p.id === providerID);
  const integrationID = provider?.integrationID;
  if (!integrationID) {
    return { error: new Error(`Provider ${providerID} has no integration`) };
  }

  const { data: integrationData, error: integrationError } = await callOpenCode(() =>
    opencodeClientV2.integration.get({ integrationID }),
  );

  if (integrationError || !integrationData) {
    return { error: integrationError };
  }

  const oauthMethod = integrationData.data.methods.filter((m) => m.type === "oauth")[methodIndex];
  if (!oauthMethod || oauthMethod.type !== "oauth") {
    return { error: new Error(`No OAuth method at index ${methodIndex} for ${providerID}`) };
  }

  const { data: connectData, error: connectError } = await callOpenCode(() =>
    opencodeClientV2.integration.oauth.connect({
      integrationID,
      methodID: oauthMethod.id,
    }),
  );

  if (connectError || !connectData) {
    return { error: connectError };
  }

  return {
    data: {
      url: connectData.data.url,
      instructions: connectData.data.instructions ?? "",
    },
  };
}
