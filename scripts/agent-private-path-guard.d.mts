export type AgentToolGuardResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export function evaluateAgentToolInput(
  input: unknown,
  fallbackCwd?: string,
): AgentToolGuardResult;
