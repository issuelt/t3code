import {
  CommandId,
  isHomeDeliveredMessage,
  isHomeThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { isNativeMaintenanceCommand } from "../orchestration-v2/CommandPolicy.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { latestSteerableRun } from "../orchestration-v2/ThreadManagementService.ts";

/**
 * Steers reports that reached Home before its turn could take them. A report sent while the
 * turn is still starting, or into a compaction, is held as a queued run; once a turn that can
 * be steered is running, the held report joins it. If the turn ends first, the report starts
 * the next turn like any queued run.
 */
export class HomeDeliveryReactor extends Context.Service<
  HomeDeliveryReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/home/HomeDeliveryReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;

  // Runs for every domain event; anything but a Home turn starting or a Home run queuing returns at once.
  const handle: HomeDeliveryReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (!isHomeThreadId(event.threadId)) return;
      // Whichever commits last, the running turn or the held report, finds the other.
      if (
        !(event.type === "provider-turn.updated" && event.payload.status === "running") &&
        !(event.type === "run.updated" && event.payload.status === "queued")
      ) {
        return;
      }
      const projection = yield* engine.getThreadRecords(
        event.threadId,
        ["runs", "messages", "providerTurns"],
        { messageRoles: ["user"] },
      );
      if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) return;
      const target = latestSteerableRun(projection);
      const targetMessage = projection.messages.find(
        (message) => message.id === target?.userMessageId,
      );
      // Steering a compaction stops it, so the report waits for the next turn instead.
      if (target === undefined || targetMessage === undefined) return;
      if (isNativeMaintenanceCommand(targetMessage)) return;
      const held = projection.runs
        .filter((run) => run.status === "queued" && run.queueHeld !== true)
        .toSorted(
          (left, right) =>
            (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
            left.ordinal - right.ordinal,
        )
        .flatMap((run) => {
          const message = projection.messages.find(
            (candidate) => candidate.id === run.userMessageId,
          );
          // Task notifications and completions have their own mailbox delivery.
          return message !== undefined &&
            message.notification === undefined &&
            message.delegatedCompletion === undefined &&
            isHomeDeliveredMessage(event.threadId, message)
            ? [run]
            : [];
        });
      for (const run of held) {
        yield* engine
          .dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make(`server:home-delivery:${run.id}:${target.id}`),
            threadId: event.threadId,
            queuedRunId: run.id,
            targetRunId: target.id,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("steering a held Home report failed", {
                threadId: event.threadId,
                runId: run.id,
                cause,
              }),
            ),
          );
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delivering held Home reports failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: HomeDeliveryReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Home delivery event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies HomeDeliveryReactor["Service"];
});

export const layer = Layer.effect(HomeDeliveryReactor, make);
