import {
  CommandId,
  type EnvironmentId,
  type EnvironmentRuntimeRequestRespondResult,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import { loadPersistedCatalog } from "../connection/registry.ts";
import type { ConnectionCatalogEntry, ConnectionRoute } from "../connection/catalog.ts";
import * as ConnectionResolver from "../connection/resolver.ts";
import { routeEntry, usableRoutes } from "../connection/routes.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "./environmentHttpAuth.ts";

// Android gives the headless task 30 s and the iOS patch holds the action for 25 s; the alert
// needs the rest to show the outcome.
const ANSWER_BUDGET_MS = 20_000;

export const respondToRuntimeRequestOverHttp = Effect.fn(
  "clientRuntime.state.respondToRuntimeRequestOverHttp",
)(function* (input: RuntimeRequestAnswer & { readonly environmentId: EnvironmentId }) {
  const { entries } = yield* loadPersistedCatalog();
  const entry = entries.get(input.environmentId);
  if (entry === undefined || !entry.enabled) {
    return { _tag: "Unreachable", environmentLabel: null } satisfies RuntimeRequestAnswerOutcome;
  }
  return yield* answerRuntimeRequestOverRoutes(entry, input);
});

/** What the server said; only `Unreachable` is worth trying again. */
export type RuntimeRequestAnswerOutcome =
  | { readonly _tag: "Answered"; readonly result: EnvironmentRuntimeRequestRespondResult }
  | { readonly _tag: "Rejected"; readonly reason: "not_permitted" | "unanswerable" }
  | { readonly _tag: "Unreachable"; readonly environmentLabel: string | null };

type RuntimeRequestRejected = Extract<RuntimeRequestAnswerOutcome, { _tag: "Rejected" }>;

const rejected = (reason: RuntimeRequestRejected["reason"]) =>
  Effect.fail<RuntimeRequestRejected>({ _tag: "Rejected", reason });

interface RuntimeRequestAnswer {
  readonly threadId: ThreadId;
  readonly requestId: RuntimeRequestId;
  readonly decision: ProviderApprovalDecision;
}

export const answerRuntimeRequestOverRoutes = Effect.fn(
  "clientRuntime.state.answerRuntimeRequestOverRoutes",
)(function* (entry: ConnectionCatalogEntry, input: RuntimeRequestAnswer) {
  // One id for every route: a route that answered before failing replays its receipt.
  const commandIdForThisTap = CommandId.make(yield* (yield* SecureRandom.SecureRandom).uuidV4());
  const resolver = yield* ConnectionResolver.ConnectionResolver;
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  );
  const params = { threadId: input.threadId, requestId: input.requestId };
  const answerOver = (route: ConnectionRoute) =>
    resolver.prepare(routeEntry(entry, route)).pipe(
      Effect.flatMap((prepared) =>
        executeAuthenticatedEnvironmentHttpRequest({
          group: "orchestration",
          prepared,
          signer,
          remoteAuthorization,
          method: "POST",
          url: (urls) => urls.respondToRuntimeRequest({ params }),
          timeoutMs: ANSWER_BUDGET_MS,
          request: ({ client, headers }) =>
            client.respondToRuntimeRequest({
              params,
              headers: withOrchestrationProtocolHeader(headers),
              payload: { commandId: commandIdForThisTap, decision: input.decision },
            }),
        }),
      ),
      Effect.map((result): RuntimeRequestAnswerOutcome => ({ _tag: "Answered", result })),
      Effect.catchTags({
        EnvironmentScopeRequiredError: () => rejected("not_permitted"),
        EnvironmentRequestInvalidError: () => rejected("unanswerable"),
        EnvironmentResourceNotFoundError: () => rejected("unanswerable"),
      }),
      // Every route starts now, so a timeout per route is one budget for the whole answer.
      Effect.timeout(ANSWER_BUDGET_MS),
    );
  const unreachable: RuntimeRequestAnswerOutcome = {
    _tag: "Unreachable",
    environmentLabel: entry.target.label,
  };
  const routes = usableRoutes(entry);
  if (routes.length === 0) return unreachable;
  // Only an answer wins the race: a route paired with fewer scopes must not stop one that can answer.
  return yield* Effect.raceAll(routes.map(answerOver)).pipe(
    Effect.catchCause((cause) => {
      const errors = cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
      if (errors.length === 0) return Effect.failCause(cause);
      const rejection = errors.find(
        (error): error is RuntimeRequestRejected => error._tag === "Rejected",
      );
      return rejection !== undefined
        ? Effect.succeed<RuntimeRequestAnswerOutcome>(rejection)
        : Effect.logWarning("Could not answer the runtime request.", { cause }).pipe(
            Effect.as(unreachable),
          );
    }),
  );
});

export const layerSocketless = ConnectionResolver.layer.pipe(
  Layer.provideMerge(RemoteEnvironmentAuthorization.layer),
);
