import {
  CommandId,
  type EnvironmentId,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import { loadPersistedCatalog } from "../connection/registry.ts";
import type { ConnectionRoute } from "../connection/catalog.ts";
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
)(function* (input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly requestId: RuntimeRequestId;
  readonly decision: ProviderApprovalDecision;
}) {
  // One id for every route: a route that answered before failing replays its receipt.
  const commandIdForThisTap = CommandId.make(yield* (yield* SecureRandom.SecureRandom).uuidV4());
  const { entries } = yield* loadPersistedCatalog();
  const entry = entries.get(input.environmentId);
  if (entry === undefined || !entry.enabled) {
    return { _tag: "Unreachable", environmentLabel: null } as const;
  }
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
    );
  return yield* Effect.firstSuccessOf(usableRoutes(entry).map(answerOver)).pipe(
    Effect.timeout(ANSWER_BUDGET_MS),
    Effect.map((result) => ({ _tag: "Answered", result }) as const),
    Effect.catch((cause) =>
      Effect.logWarning("Could not answer the runtime request.", { cause }).pipe(
        Effect.as({ _tag: "Unreachable", environmentLabel: entry.target.label } as const),
      ),
    ),
  );
});

export const layerSocketless = ConnectionResolver.layer.pipe(
  Layer.provideMerge(RemoteEnvironmentAuthorization.layer),
);
