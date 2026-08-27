import { evaluateAgentToolInput } from "../../scripts/agent-private-path-guard.mjs";

type PiToolCallEvent = {
  toolName: string;
  input: unknown;
};

type PiExtensionContext = {
  cwd: string;
};

type PiExtensionApi = {
  on(
    event: "tool_call",
    handler: (
      toolCall: PiToolCallEvent,
      context: PiExtensionContext,
    ) => Promise<{ block: true; reason: string } | undefined>,
  ): void;
};

export default function privateFinanceGuard(pi: PiExtensionApi) {
  pi.on("tool_call", async (event, context) => {
    const result = evaluateAgentToolInput({
      cwd: context.cwd,
      tool_name: event.toolName,
      tool_input: event.input,
    }, context.cwd);
    if (!result.allowed) {
      return {
        block: true,
        reason: `Blocked by LocalFi: ${result.reason} is outside the agent source boundary.`,
      };
    }
  });
}
