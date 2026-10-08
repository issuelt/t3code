import {
  CommandId,
  ProviderInstanceId,
  isProviderAvailable,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { AutoFallbackCooldownTracker } from "./autoFallback/CooldownTracker.ts";
import { selectFallbackCandidate } from "./autoFallback/candidates.ts";
import { isInstanceCoolingDown } from "./autoFallback/cooldown.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";

/** Reuse the persisted user message and the normal V2 provider-switch path. */
export const makeAccountFallback = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;
  const registry = yield* ProviderRegistry;
  const settings = yield* ServerSettingsService;
  const cooldown = yield* AutoFallbackCooldownTracker;
  return Effect.fn("AccountFallbackWorker.handle")(function* (event: OrchestrationV2DomainEvent) {
    if (event.type !== "run.updated" || event.payload.status !== "failed") return;
    const projection = yield* orchestrator.getThreadRecords(event.threadId, [
      "runs",
      "turnItems",
      "messages",
      "runtimeRequests",
    ]);
    const run = projection.runs.at(-1);
    if (run?.id !== event.payload.id || run.status !== "failed") return;
    const failure = latestRootProviderFailure(run, projection.turnItems);
    if (failure?.class !== "usage_limit") return;
    yield* cooldown.recordLimitHit(run.providerInstanceId, {
      kind: "usage_limit",
      ...(failure.resetAt ? { resetAt: failure.resetAt } : {}),
    });
    const preferences = yield* settings.getSettings;
    if (!preferences.autoFallbackBetweenAccounts) return;
    const thread = projection.thread;
    if (
      thread.providerInstanceId !== run.providerInstanceId ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      thread.settledOverride === "settled" ||
      thread.snoozedUntil != null ||
      projection.runtimeRequests.some((r) => r.status === "pending")
    )
      return;
    const message = projection.messages.find((m) => m.id === run.userMessageId);
    if (!message) return;
    const providers = yield* registry.getProviders;
    const failed = providers.find((p) => p.instanceId === run.providerInstanceId);
    if (!failed) return;
    const cooldowns = yield* cooldown.snapshot;
    const now = yield* Clock.currentTimeMillis;
    const { candidate } = selectFallbackCandidate({
      instances: Object.entries(deriveProviderInstanceConfigMap(preferences)).map(
        ([instanceId, config]) => ({
          instanceId,
          driver: String(config.driver),
          participateInFallback: config.participateInFallback,
        }),
      ),
      snapshots: new Map(
        providers.map((p) => [
          p.instanceId,
          {
            instanceId: p.instanceId,
            enabled: p.enabled,
            available: isProviderAvailable(p),
            authStatus: p.auth.status,
            modelSlugs: p.models.map((m) => m.slug),
          },
        ]),
      ),
      failedInstanceId: run.providerInstanceId,
      driver: String(failed.driver),
      requiredModel: run.modelSelection.model,
      attemptedInstanceIds: new Set(
        projection.runs
          .filter((r) => r.userMessageId === message.id)
          .map((r) => r.providerInstanceId),
      ),
      isCoolingDown: (id) => isInstanceCoolingDown(cooldowns, id, now),
    });
    if (!candidate) return;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`account-fallback:${run.id}`),
      threadId: event.threadId,
      accountFallbackOfRunId: run.id,
      messageId: message.id,
      text: message.text,
      ...(message.context ? { context: message.context } : {}),
      attachments: message.attachments,
      modelSelection: {
        ...run.modelSelection,
        instanceId: ProviderInstanceId.make(candidate.instanceId),
      },
      dispatchMode: { type: "start_immediately" },
      createdBy: message.createdBy,
      creationSource: "server",
    });
  });
});

export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const handle = yield* makeAccountFallback;
    yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter((event) => event.type === "run.updated" && event.payload.status === "failed"),
      Stream.runForEach((event) => handle(event).pipe(Effect.ignoreCause({ log: true }))),
      Effect.forkScoped,
    );
  }),
);
