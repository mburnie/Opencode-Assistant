import type { ToolStreamKey } from "./streaming/tool-call-streamer.js";

const TELEGRAM_DOCUMENT_CAPTION_MAX_LENGTH = 1024;

export function prepareDocumentCaption(caption: string): string {
  const normalizedCaption = caption.trim();
  if (!normalizedCaption) {
    return "";
  }

  if (normalizedCaption.length <= TELEGRAM_DOCUMENT_CAPTION_MAX_LENGTH) {
    return normalizedCaption;
  }

  return `${normalizedCaption.slice(0, TELEGRAM_DOCUMENT_CAPTION_MAX_LENGTH - 3)}...`;
}

export function getToolStreamKey(tool: string): ToolStreamKey {
  if (tool === "todowrite") {
    return "todo";
  }

  return "default";
}

