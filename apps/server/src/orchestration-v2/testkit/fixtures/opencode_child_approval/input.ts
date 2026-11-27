import { OPENCODE_SUBAGENT_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCodeChildApprovalInput(): OrchestratorFixtureInput {
  return {
    // The fork accepts every Full access ask itself, so the approval card needs a mode that asks.
    runtimeMode: "approval-required",
    steps: [
      { type: "message", text: OPENCODE_SUBAGENT_PROMPT },
      { type: "approve_next_runtime_request" },
    ],
  };
}
