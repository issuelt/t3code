import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as WorkFilesTransfer from "../../../peer/WorkFilesTransfer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { launchCommandId, unavailable } from "../../threadAccess.ts";
import { WorkFilesToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(WorkFilesToolkit, {
  // Receiving files edits the checkout: no link below auto-accept-edits, no stopped caller.
  t3_work_files_receive: McpToolAccess.writes(
    (request) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        if (scope.client?.linked !== true) {
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Only a linked environment can send work files here.",
          });
        }
        // A request the link narrowed (`T3-Mode-Limit`) is held to its narrower mode.
        const narrowed = McpInvocationContext.clientModeCeiling(scope.client).runtimeMode;
        const refusal =
          WorkFilesTransfer.receiveAccessRefusal(scope.client.access) ??
          (WorkFilesTransfer.receiveAccessRefusal(narrowed) === null
            ? null
            : `The thread sending these files runs in ${narrowed} mode, which cannot change files here; sending work files needs auto-accept-edits or broader.`);
        if (refusal !== null) {
          return yield* new OrchestratorMcpFailure({ code: "capability_denied", message: refusal });
        }
        // A retry whose launch went through, though its answer was lost, finds the thread
        // that launch made: its files went first, and its task may have edited them since.
        if (request.clientRequestId !== undefined) {
          const threadId = yield* launchCommandId(scope.requestNamespace, request.clientRequestId);
          const launched = yield* ThreadManagement.ThreadManagementService.pipe(
            Effect.flatMap((threads) => threads.getThreadShell(ThreadId.make(threadId))),
            Effect.mapError(unavailable),
          );
          if (launched !== null && launched.deletedAt === null) return { launched: true as const };
        }
        const transfer = yield* WorkFilesTransfer.WorkFilesTransfer;
        return yield* transfer.issueReceive({ request, sessionId: scope.client.sessionId });
      }),
    { linkedCallers: "allowed" },
  ),
});
