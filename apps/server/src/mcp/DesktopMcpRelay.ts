import { type DesktopMcpInvokeInput, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** Runs relayed calls through ordinary toolkit declarations, never Home's fleet handlers. */
export class DesktopMcpRelay extends Context.Service<
  DesktopMcpRelay,
  {
    readonly invoke: (
      input: DesktopMcpInvokeInput,
      sessionId: string,
    ) => Effect.Effect<unknown, OrchestratorMcpFailure>;
  }
>()("t3/mcp/DesktopMcpRelay") {}
