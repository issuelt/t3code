import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import {
  EnvironmentCloudEndpointUnavailableError,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpConflictError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
  EnvironmentHttpUnauthorizedError,
} from "@t3tools/contracts";
import {
  type RelayEnvironmentLinkResponse as RelayEnvironmentLinkResponseType,
  type RelayManagedEndpointProviderKind,
} from "@t3tools/contracts/relay";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import { ManagedRelay, relayRequestFailureDetail } from "@t3tools/client-runtime/relay";
import { executeConnectedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";

import type { SavedRemoteConnection } from "../../lib/connection";
import * as MobileStorage from "../../persistence/mobile-storage";
import { resolveCloudPublicConfig } from "./publicConfig";

function readRelayUrl(): string | null {
  return resolveCloudPublicConfig().relay.url;
}

export class CloudEnvironmentLinkError extends Schema.TaggedError<CloudEnvironmentLinkError>()(
  "CloudEnvironmentLinkError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    traceId: Schema.optional(Schema.String),
  },
) {}

const isEnvironmentCloudApiError = Schema.is(
  Schema.Union([
    EnvironmentHttpBadRequestError,
    EnvironmentHttpUnauthorizedError,
    EnvironmentHttpForbiddenError,
    EnvironmentHttpConflictError,
    EnvironmentHttpInternalServerError,
    EnvironmentCloudEndpointUnavailableError,
  ]),
);

const MANAGED_ENDPOINT_PROVIDER_KIND =
  "cloudflare_tunnel" satisfies RelayManagedEndpointProviderKind;

function cloudEnvironmentLinkError(message: string) {
  return (cause: unknown) => {
    const environmentError = findEnvironmentCloudApiError(cause);
    const traceId = findErrorTraceId(cause);
    const detail = environmentError
      ? `${message.replace(/[.:]$/, "")}: ${environmentError.message}`
      : withDevCause(message, cause);
    return new CloudEnvironmentLinkError({
      message: detail,
      cause,
      ...(traceId === null ? {} : { traceId }),
    });
  };
}

function isDevRuntime(): boolean {
  return typeof __DEV__ !== "undefined" && __DEV__;
}

function causeMessage(cause: unknown): string | null {
  if (cause instanceof Error && cause.message) {
    return cause.message;
  }
  if (typeof cause === "object" && cause !== null) {
    const record = cause as { readonly message?: unknown; readonly cause?: unknown };
    if (typeof record.message === "string" && record.message.length > 0) {
      const nested = causeMessage(record.cause);
      return nested ? `${record.message}: ${nested}` : record.message;
    }
  }
  return null;
}

function withDevCause(message: string, cause: unknown): string {
  if (!isDevRuntime()) {
    return message;
  }
  const detail = causeMessage(cause);
  return detail ? `${message} (${detail})` : message;
}

function decodedRelayClientError(message: string) {
  return (cause: ManagedRelay.ManagedRelayClientError) => {
    const failed = cause._tag === "ManagedRelayRequestFailedError" ? cause : undefined;
    const traceId = failed?.traceId;
    const detail = failed ? relayRequestFailureDetail(failed) : null;
    return new CloudEnvironmentLinkError({
      message: detail ? `${message}: ${detail}` : message,
      cause,
      ...(traceId ? { traceId } : {}),
    });
  };
}

function findEnvironmentCloudApiError(cause: unknown): { readonly message: string } | null {
  if (isEnvironmentCloudApiError(cause)) {
    return cause;
  }
  if (typeof cause !== "object" || cause === null) {
    return null;
  }
  return "cause" in cause ? findEnvironmentCloudApiError(cause.cause) : null;
}

function requireRelayUrl(): Effect.Effect<string, CloudEnvironmentLinkError> {
  const relayUrl = readRelayUrl();
  return relayUrl
    ? Effect.succeed(relayUrl)
    : Effect.fail(new CloudEnvironmentLinkError({ message: "Relay URL is not configured." }));
}

function endpointOrigin(httpBaseUrl: string) {
  const url = new URL(httpBaseUrl);
  return {
    localHttpHost: "127.0.0.1",
    localHttpPort: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
  };
}

function ensureLinkedEnvironmentMatches(input: {
  readonly expectedEnvironmentId: string;
  readonly expectedProviderKind: RelayManagedEndpointProviderKind;
  readonly link: RelayEnvironmentLinkResponseType;
}): Effect.Effect<void, CloudEnvironmentLinkError> {
  if (input.link.environmentId !== input.expectedEnvironmentId) {
    return new CloudEnvironmentLinkError({
      message: "Relay returned credentials for a different environment.",
    });
  }
  if (input.link.endpoint.providerKind !== input.expectedProviderKind) {
    return new CloudEnvironmentLinkError({
      message: "Relay returned credentials for a different endpoint provider.",
    });
  }
  return Effect.void;
}

// Linking can install the relay client and start a managed tunnel before it answers.
const CLOUD_LINK_REQUEST_TIMEOUT_MS = 60_000;

type ConnectedEnvironmentHttpRequest<A, E, R> = Parameters<
  typeof executeConnectedEnvironmentHttpRequest<"connect", A, E, R>
>[0];

/** Runs on the environment with the credential its supervised connection holds. */
const connectRequest = <A, E, R>(
  connection: SavedRemoteConnection,
  input: Omit<ConnectedEnvironmentHttpRequest<A, E, R>, "group" | "timeoutMs">,
  failureMessage: string,
) =>
  Effect.flatMap(EnvironmentRegistry.EnvironmentRegistry, (registry) =>
    registry.run(
      connection.environmentId,
      executeConnectedEnvironmentHttpRequest({
        ...input,
        group: "connect",
        timeoutMs: CLOUD_LINK_REQUEST_TIMEOUT_MS,
      }),
    ),
  ).pipe(Effect.mapError(cloudEnvironmentLinkError(failureMessage)));

interface LinkEnvironmentToCloudInput {
  readonly connection: SavedRemoteConnection;
  readonly clerkToken: string;
}

type LinkEnvironmentToCloudRequirements =
  | EnvironmentRegistry.EnvironmentRegistry
  | HttpClient.HttpClient
  | ManagedRelay.ManagedRelayClient
  | MobileStorage.MobileStorage;

export const linkEnvironmentToCloudWithPreference = Effect.fn(
  "linkEnvironment.linkEnvironmentToCloudWithPreference",
)(function* (
  input: LinkEnvironmentToCloudInput & { readonly liveActivitiesEnabled: boolean },
): Effect.fn.Return<void, CloudEnvironmentLinkError, LinkEnvironmentToCloudRequirements> {
  const relayUrl = yield* requireRelayUrl();
  const relayClient = yield* ManagedRelay.ManagedRelayClient;
  const storage = yield* MobileStorage.MobileStorage;
  const deviceId = yield* storage.loadOrCreateAgentAwarenessDeviceId.pipe(
    Effect.mapError(cloudEnvironmentLinkError("Could not load the mobile device id.")),
  );
  const liveActivitiesEnabled = input.liveActivitiesEnabled;
  const challenge = yield* relayClient
    .createEnvironmentLinkChallenge({
      clerkToken: input.clerkToken,
      payload: {
        notificationsEnabled: true,
        liveActivitiesEnabled,
        managedTunnelsEnabled: true,
      },
    })
    .pipe(
      Effect.mapError(
        decodedRelayClientError(`${relayUrl}/v1/client/environment-link-challenges failed`),
      ),
    );
  const proof = yield* connectRequest(
    input.connection,
    {
      method: "POST",
      url: (urls) => urls.linkProof(),
      request: ({ client, headers }) =>
        client.linkProof({
          headers,
          payload: {
            challenge: challenge.challenge,
            relayIssuer: relayUrl,
            endpoint: {
              httpBaseUrl: input.connection.httpBaseUrl,
              wsBaseUrl: input.connection.wsBaseUrl,
              providerKind: MANAGED_ENDPOINT_PROVIDER_KIND,
            },
            origin: endpointOrigin(input.connection.httpBaseUrl),
          },
        }),
    },
    "Could not obtain environment link proof.",
  );
  const link = yield* relayClient
    .linkEnvironment({
      clerkToken: input.clerkToken,
      payload: {
        deviceId,
        proof,
        notificationsEnabled: true,
        liveActivitiesEnabled,
        managedTunnelsEnabled: true,
      },
    })
    .pipe(
      Effect.mapError(decodedRelayClientError(`${relayUrl}/v1/client/environment-links failed`)),
    );
  yield* ensureLinkedEnvironmentMatches({
    expectedEnvironmentId: input.connection.environmentId,
    expectedProviderKind: MANAGED_ENDPOINT_PROVIDER_KIND,
    link,
  });

  yield* connectRequest(
    input.connection,
    {
      method: "POST",
      url: (urls) => urls.relayConfig(),
      request: ({ client, headers }) =>
        client.relayConfig({
          headers,
          payload: {
            relayUrl,
            relayIssuer: link.relayIssuer,
            cloudUserId: link.cloudUserId,
            environmentCredential: link.environmentCredential,
            cloudMintPublicKey: link.cloudMintPublicKey,
            endpointRuntime: link.endpointRuntime,
          },
        }),
    },
    "Could not configure environment relay access.",
  );
});
