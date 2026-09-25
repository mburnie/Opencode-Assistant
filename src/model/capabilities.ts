import { listProvidersWithModels } from "../opencode/client-v2.js";
import { logger } from "../utils/logger.js";

export interface ModelCapabilities {
  tools: boolean;
  input: string[];
  output: string[];
}

interface ModelCapabilitiesCache {
  [key: string]: ModelCapabilities | null;
}

const capabilitiesCache: ModelCapabilitiesCache = {};

/**
 * Get model capabilities from OpenCode API
 * Results are cached in memory per model
 */
export async function getModelCapabilities(
  providerID: string,
  modelID: string,
): Promise<ModelCapabilities | null> {
  const cacheKey = `${providerID}/${modelID}`;

  if (capabilitiesCache[cacheKey] !== undefined) {
    logger.debug(`[ModelCapabilities] Cache hit for ${cacheKey}`);
    return capabilitiesCache[cacheKey];
  }

  try {
    logger.debug(`[ModelCapabilities] Fetching capabilities for ${cacheKey}`);
    const { data: providersData, error } = await listProvidersWithModels();

    if (error || !providersData) {
      logger.error("[ModelCapabilities] API returned error:", error);
      capabilitiesCache[cacheKey] = null;
      return null;
    }

    const provider = providersData.find((p) => p.id === providerID);

    if (!provider) {
      logger.warn(`[ModelCapabilities] Provider ${providerID} not found`);
      capabilitiesCache[cacheKey] = null;
      return null;
    }

    const model = provider.models[modelID];

    if (!model) {
      logger.warn(`[ModelCapabilities] Model ${cacheKey} not found in provider`);
      capabilitiesCache[cacheKey] = null;
      return null;
    }

    logger.debug(`[ModelCapabilities] Found capabilities for ${cacheKey}`);
    capabilitiesCache[cacheKey] = model.capabilities;
    return model.capabilities;
  } catch (error) {
    logger.error("[ModelCapabilities] Failed to fetch providers:", error);
    capabilitiesCache[cacheKey] = null;
    return null;
  }
}

/**
 * Check if model supports a specific input type
 */
export function supportsInput(
  capabilities: ModelCapabilities | null,
  inputType: "image" | "pdf" | "audio" | "video" | string,
): boolean {
  if (!capabilities) {
    return false;
  }

  return capabilities.input.includes(inputType);
}

/**
 * Check if model supports attachments in general
 */
export function supportsAttachment(capabilities: ModelCapabilities | null): boolean {
  if (!capabilities) {
    return false;
  }

  return capabilities.input.some((input) => input === "pdf" || input === "image");
}
