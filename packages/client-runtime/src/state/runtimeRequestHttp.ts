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
import * as ConnectionResolver from "../connection/resolver.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "./environmentHttpAuth.ts";

const RESPOND_TIMEOUT_MS = 15_000;

/**
 * Answers a runtime request over HTTP with this device's saved credential, without opening a
 * socket, for work that runs while the app is in the background. Any failure is `Unreachable`:
 * the caller offers the same answer again rather than retrying on its own.
 */
export const respondToRuntimeRequestOverHttp = Effect.fn(
  "clientRuntime.state.respondToRuntimeRequestOverHttp",
)(function* (input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly requestId: RuntimeRequestId;
  readonly decision: ProviderApprovalDecision;
}) {
  // A fresh id per tap: if an earlier tap landed but its answer was lost, this one finds the
  // request resolved instead of replaying that tap's receipt.
  const commandId = CommandId.make(yield* (yield* SecureRandom.SecureRandom).uuidV4());
  const { entries } = yield* loadPersistedCatalog();
  const entry = entries.get(input.environmentId);
  if (entry === undefined || !entry.enabled) {
    return { _tag: "Unreachable", environmentLabel: null } as const;
  }
  const resolver = yield* ConnectionResolver.ConnectionResolver;
  const params = { threadId: input.threadId, requestId: input.requestId };
  return yield* resolver.prepare(entry).pipe(
    Effect.flatMap(
      Effect.fnUntraced(function* (prepared) {
        return yield* executeAuthenticatedEnvironmentHttpRequest({
          group: "orchestration",
          prepared,
          signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
          remoteAuthorization: yield* Effect.serviceOption(
            RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
          ),
          method: "POST",
          url: (urls) => urls.respondToRuntimeRequest({ params }),
          timeoutMs: RESPOND_TIMEOUT_MS,
          request: ({ client, headers }) =>
            client.respondToRuntimeRequest({
              params,
              headers: withOrchestrationProtocolHeader(headers),
              payload: { commandId, decision: input.decision },
            }),
        });
      }),
    ),
    Effect.map((result) => ({ _tag: "Answered", result }) as const),
    Effect.catch((cause) =>
      Effect.logWarning("Could not answer the runtime request.", { cause }).pipe(
        Effect.as({ _tag: "Unreachable", environmentLabel: entry.target.label } as const),
      ),
    ),
  );
});

/** The connection services that answer a request over HTTP; no socket or supervisor starts. */
export const layerSocketless = ConnectionResolver.layer.pipe(
  Layer.provideMerge(RemoteEnvironmentAuthorization.layer),
);
