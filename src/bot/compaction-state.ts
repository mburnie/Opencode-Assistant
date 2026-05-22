const compactingSessions = new Set<string>();

export function markCompacting(sessionId: string): void {
  compactingSessions.add(sessionId);
}

export function unmarkCompacting(sessionId: string): void {
  compactingSessions.delete(sessionId);
}

export function isCompacting(sessionId: string): boolean {
  return compactingSessions.has(sessionId);
}
