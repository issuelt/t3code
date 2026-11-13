import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const driver = ProviderDriverKind.make("codex");
const selection = {
  instanceId: ProviderInstanceId.make("codex-home-roll"),
  model: "home-roll-model",
} satisfies ModelSelection;

// Every turn reports a half-full window, so each turn after the first rolls Home.
function makeHalfFullAdapter(
  freshSessions: Ref.Ref<number>,
): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId: selection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" } as const),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId: selection.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? "/fallback",
          model: sessionInput.modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        return {
          instanceId: selection.instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromQueue(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const native = yield* Ref.updateAndGet(freshSessions, (count) => count + 1);
              return {
                ...threadInput.existingProviderThread,
                id:
                  threadInput.existingProviderThread?.id ??
                  ProviderThreadId.make(`provider-thread:${threadInput.threadId}`),
                driver,
                providerInstanceId: selection.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: `native:${native}`, strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (input) =>
            Effect.gen(function* () {
              const occurredAt = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(`provider-turn:${input.attemptId}`);
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: input.providerThread.id,
                  nodeId: input.rootNodeId,
                  runAttemptId: input.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${providerTurnId}`,
                    strength: "strong",
                  },
                  ordinal: input.providerTurnOrdinal,
                  status: "completed",
                  startedAt: occurredAt,
                  completedAt: occurredAt,
                  tokenUsage: {
                    usedTokens: 150_000,
                    maxTokens: 200_000,
                    updatedAt: DateTime.formatIso(occurredAt),
                  },
                },
              });
              yield* Queue.offer(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: input.providerThread.id,
                providerTurnId,
                runOrdinal: input.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        };
      }),
  };
}

it.live("keeps one handoff record and no empty timeline slot across many Home rolls", () =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace("home-roll");
    const threadId = ThreadId.make("home:roll");
    const freshSessions = yield* Ref.make(0);
    const rolls = 12;

    const result = yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:home-roll:create"),
        threadId,
        projectId: ProjectId.make("project:home-roll"),
        title: "Home",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
      });
      for (let turn = 0; turn <= rolls; turn++) {
        const completed = yield* eventSink
          .stream({ threadId, afterSequence: yield* eventSink.latestSequence({ threadId }) })
          .pipe(
            Stream.map((stored) => stored.event),
            Stream.filter(
              (event) => event.type === "run.updated" && event.payload.status === "completed",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:home-roll:${turn}`),
          threadId,
          messageId: MessageId.make(`message:home-roll:${turn}`),
          text: `TURN_${turn} ${"x".repeat(8_000)}`,
          attachments: [],
          modelSelection: selection,
          dispatchMode: { type: "start_immediately" },
        });
        yield* Fiber.join(completed);
        yield* worker.drain();
      }
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const positions = yield* sql<{ readonly turn_item_id: string }>`
        SELECT turn_item_id FROM orchestration_v2_turn_item_positions WHERE thread_id = ${threadId}
      `;
      const itemIds = new Set(projection.turnItems.map((item) => String(item.id)));
      return {
        handoffs: projection.contextHandoffs.length,
        transfers: projection.contextTransfers.length,
        emptyPositions: positions.filter((row) => !itemIds.has(row.turn_item_id)).length,
      };
    }).pipe(
      Effect.provide(
        Layer.merge(
          ProviderReplayHarness.layerWithRegistry(
            { name: "home-roll" },
            ProviderAdapterRegistry.layerSingle(makeHalfFullAdapter(freshSessions)),
            { databaseLayer: SqlitePersistence.layerMemory },
          ),
          SqlitePersistence.layerMemory,
        ),
      ),
    );

    assert.equal(yield* Ref.get(freshSessions), rolls + 1);
    assert.deepEqual(result, { handoffs: 1, transfers: 1, emptyPositions: 0 });
  }),
);
