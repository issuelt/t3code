import {
  AuthAccessTokenType,
  type ClientConnectionMethod,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { RelayEnvironmentConnectScope } from "@t3tools/contracts/relay";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import {
  exchangeRemoteDpopAccessToken,
  fetchRemoteAuthDescriptor,
  type RemoteEnvironmentAuthError,
  resolveRemoteDpopWebSocketConnectionUrl,
  resolveRemoteWebSocketConnectionUrl,
} from "./remote.ts";
import {
  BearerConnectionCredential,
  type ConnectionCredential,
  DpopConnectionCredential,
} from "../connection/catalog.ts";
import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import {
  credentialMissingError,
  environmentMismatchError,
  mapManagedRelayError,
  mapRemoteDpopEnvironmentError,
  mapRemoteEnvironmentError,
} from "../connection/errors.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
} from "../connection/model.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as TokenStore from "./tokenStore.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";

import {
  DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";

export interface AuthorizedRemoteEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization;
  readonly descriptor?: ExecutionEnvironmentDescriptor;
}

export interface AuthorizedRemoteHttpEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly httpAuthorization: Extract<PreparedHttpAuthorization, { readonly _tag: "Dpop" }>;
}

export class RemoteEnvironmentAuthorization extends Context.Service<
  RemoteEnvironmentAuthorization,
  {
    readonly authorizeBearer: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
      readonly connectionMethod: ClientConnectionMethod;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    readonly authorizeDpop: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      /**
       * The access token is not bound to an origin, and each proof is minted
       * for the URL it signs, so a token from the relay also works on the
       * environment's LAN or tailnet address.
       */
      readonly directEndpoint?: { readonly httpBaseUrl: string; readonly wsBaseUrl: string };
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    /**
     * Authorizes a paired address with its saved credential. A DPoP credential
     * renews with the environment; a paired bearer converts to DPoP once when
     * the environment offers it.
     */
    readonly authorizeDirect: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly credentialId: string;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    readonly authorizeDpopHttp: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly rejectedAccessToken?: string;
      readonly direct?: DirectDpopCredential;
    }) => Effect.Effect<AuthorizedRemoteHttpEnvironment, ConnectionAttemptError>;
    /**
     * Renews a live socket's token before it expires, so the server moves the
     * socket to the new session instead of closing it. Runs until interrupted.
     */
    readonly renewDpopBeforeExpiry: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly expiresAtEpochMs: number;
      readonly direct?: DirectDpopCredential;
    }) => Effect.Effect<void, ConnectionBlockedError>;
  }
>()("@t3tools/client-runtime/authorization/service/RemoteEnvironmentAuthorization") {}

/** A paired DPoP credential and the address its renewals go to. */
export interface DirectDpopCredential {
  readonly credentialId: string;
  readonly httpBaseUrl: string;
  readonly label: string;
}

/**
 * Pairing names its credentials `bearer:…`. Desktop-local backends and SSH
 * routes keep their own bearer tokens, so only paired ones may convert.
 */
const PAIRED_CREDENTIAL_PREFIX = "bearer:";

const CACHED_ENDPOINT_SOCKET_TIMEOUT_MS = 3_000;
const DPOP_AUTHORIZATION_TIMEOUT_MS = 30_000;

function mapDpopSocketError(
  error: RemoteEnvironmentAuthError | ConnectionAttemptError,
  connectionMethod: "relay" | "direct" = "relay",
) {
  return error._tag === "ConnectionTransientError" || error._tag === "ConnectionBlockedError"
    ? error
    : mapRemoteDpopEnvironmentError(error, connectionMethod);
}

const fetchDescriptor = Effect.fn("clientRuntime.connection.remote.fetchDescriptor")(function* (
  httpBaseUrl: string,
  connectionMethod: ClientConnectionMethod,
) {
  return yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.mapError((error) => mapRemoteEnvironmentError(error, connectionMethod)),
  );
});

export const make = Effect.gen(function* () {
  const serviceScope = yield* Scope.Scope;
  const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
  const relay = yield* ManagedRelay.ManagedRelayClient;
  const cloudSession = yield* ClientCapabilities.CloudSession;
  const deviceIdentity = yield* ClientCapabilities.RelayDeviceIdentity;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const tokenStore = yield* TokenStore.RemoteDpopAccessTokenStore;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const httpClient = yield* HttpClient.HttpClient;
  const tokenLock = yield* Semaphore.make(1);
  const directLocks = new Map<string, Semaphore.Semaphore>();
  // Bearers already offered for conversion, or found on a server without it, this run.
  const conversionChecked = new Set<string>();
  const tokenOwners = new Map<
    EnvironmentId,
    { readonly accessToken: string; readonly identity: ClientCapabilities.CloudSessionIdentity }
  >();
  const pendingTokens = new Map<
    EnvironmentId,
    {
      readonly id: object;
      readonly identity: ClientCapabilities.CloudSessionIdentity;
      readonly thumbprint: string;
      readonly token: Effect.Effect<TokenStore.RemoteDpopAccessToken, ConnectionAttemptError>;
    }
  >();

  /**
   * A saved LAN address can belong to another machine on a different network.
   */
  const verifyDirectEndpoint = Effect.fn("clientRuntime.connection.remote.verifyDirectEndpoint")(
    function* (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly connectionMethod: ClientConnectionMethod;
    }) {
      const descriptor = yield* fetchDescriptor(input.httpBaseUrl, input.connectionMethod).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      if (descriptor.environmentId !== input.expectedEnvironmentId) {
        return yield* environmentMismatchError({
          expected: input.expectedEnvironmentId,
          actual: descriptor.environmentId,
        });
      }
      return descriptor;
    },
  );

  const authorizeBearer = Effect.fn("clientRuntime.connection.remote.authorizeBearer")(
    function* (input: {
      readonly expectedEnvironmentId: Parameters<
        RemoteEnvironmentAuthorization["Service"]["authorizeBearer"]
      >[0]["expectedEnvironmentId"];
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
      readonly connectionMethod: ClientConnectionMethod;
    }) {
      return yield* bearerSocket(input, yield* verifyDirectEndpoint(input));
    },
  );

  const bearerSocket = Effect.fn("clientRuntime.connection.remote.bearerSocket")(function* (
    input: {
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
      readonly connectionMethod: ClientConnectionMethod;
    },
    descriptor: ExecutionEnvironmentDescriptor,
  ) {
    const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
      wsBaseUrl: input.wsBaseUrl,
      httpBaseUrl: input.httpBaseUrl,
      bearerToken: input.bearerToken,
      clientMetadata: presentation.metadata,
      connectionMethod: input.connectionMethod,
    }).pipe(
      Effect.mapError(mapRemoteEnvironmentError),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return {
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: input.httpBaseUrl,
      socketUrl,
      descriptor,
      httpAuthorization: {
        _tag: "Bearer" as const,
        token: input.bearerToken,
      },
    };
  });

  const createDpopSocketUrl = Effect.fn("clientRuntime.connection.remote.createDpopSocketUrl")(
    function* (
      accessToken: string,
      endpoint: { readonly httpBaseUrl: string; readonly wsBaseUrl: string },
      connectionMethod: "relay" | "direct",
      timeoutMs?: number,
    ) {
      return yield* resolveRemoteDpopWebSocketConnectionUrl({
        wsBaseUrl: endpoint.wsBaseUrl,
        httpBaseUrl: endpoint.httpBaseUrl,
        accessToken,
        createProof: (proof) =>
          signer.createProof(proof).pipe(
            Effect.mapError(
              () =>
                new ConnectionBlockedError({
                  reason: "configuration",
                  detail: "Could not create the websocket authorization proof.",
                }),
            ),
          ),
        clientMetadata: presentation.metadata,
        connectionMethod,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    },
    Effect.provideService(HttpClient.HttpClient, httpClient),
  );

  const sessionChanged = () =>
    new ConnectionBlockedError({
      reason: "authentication",
      detail: "Your cloud sign-in changed. Sign in again to authorize the environment.",
    });

  // A missing identity before the attempt captures one means the cloud session
  // is still loading, not a sign-out. Only a captured identity that goes away
  // or changes is evidence of one.
  const sessionPending = () =>
    new ConnectionTransientError({
      reason: "session-pending",
      detail: "Waiting for the T3 Connect sign-in to load.",
    });

  const assertSession = Effect.fnUntraced(function* (
    identity: ClientCapabilities.CloudSessionIdentity,
  ) {
    const current = yield* cloudSession.identity;
    if (Option.isNone(current) || current.value !== identity) {
      return yield* sessionChanged();
    }
  });

  // Called under tokenLock so a late rejection cannot remove a newer credential.
  const removeRejectedToken = Effect.fnUntraced(function* (
    environmentId: EnvironmentId,
    accessToken: string,
  ) {
    const cached = yield* tokenStore.get(environmentId);
    if (Option.isSome(cached) && cached.value.accessToken === accessToken) {
      yield* tokenStore.remove(environmentId);
      tokenOwners.delete(environmentId);
    }
  });

  const obtainBootstrap = Effect.fn("relay.connection.bootstrap.obtain")(function* (
    environmentId: EnvironmentId,
    identity: ClientCapabilities.CloudSessionIdentity,
  ) {
    yield* assertSession(identity);
    const clerkToken = yield* cloudSession.clerkToken.pipe(
      Effect.withSpan("relay.connection.cloudSessionToken.resolve"),
    );
    const deviceId = yield* deviceIdentity.deviceId.pipe(
      Effect.withSpan("relay.connection.deviceIdentity.resolve"),
    );
    yield* assertSession(identity);
    const connected = yield* relay
      .connectEnvironment({
        clerkToken,
        scopes: [RelayEnvironmentConnectScope],
        environmentId,
        ...(Option.isSome(deviceId) ? { deviceId: deviceId.value } : {}),
      })
      .pipe(Effect.mapError(mapManagedRelayError));
    if (connected.environmentId !== environmentId) {
      return yield* environmentMismatchError({
        expected: environmentId,
        actual: connected.environmentId,
      });
    }
    yield* assertSession(identity);
    return connected;
  });

  const exchangeDpopToken = Effect.fn("clientRuntime.connection.remote.exchangeDpopToken")(
    function* (
      environmentId: EnvironmentId,
      thumbprint: string,
      identity: ClientCapabilities.CloudSessionIdentity,
    ) {
      const bootstrap = yield* obtainBootstrap(environmentId, identity);
      const descriptor = yield* fetchDescriptor(bootstrap.endpoint.httpBaseUrl, "relay").pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.withSpan("environment.authorization.descriptor"),
      );
      if (descriptor.environmentId !== environmentId) {
        return yield* environmentMismatchError({
          expected: environmentId,
          actual: descriptor.environmentId,
        });
      }
      const bootstrapProof = yield* signer
        .createProof({
          method: "POST",
          url: environmentEndpointUrl(bootstrap.endpoint.httpBaseUrl, "/oauth/token"),
        })
        .pipe(
          Effect.mapError(
            () =>
              new ConnectionBlockedError({
                reason: "configuration",
                detail: "Could not create the environment authorization proof.",
              }),
          ),
        );
      yield* assertSession(identity);
      const access = yield* exchangeRemoteDpopAccessToken({
        httpBaseUrl: bootstrap.endpoint.httpBaseUrl,
        credential: bootstrap.credential,
        dpopProof: bootstrapProof,
        clientMetadata: presentation.metadata,
      }).pipe(
        Effect.mapError(mapRemoteDpopEnvironmentError),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.withSpan("environment.authorization.accessToken.exchange"),
      );
      const issuedAt = yield* Clock.currentTimeMillis;
      return new TokenStore.RemoteDpopAccessToken({
        environmentId: descriptor.environmentId,
        accountId: identity.accountId,
        label: descriptor.label,
        endpoint: bootstrap.endpoint,
        accessToken: access.access_token,
        expiresAtEpochMs: issuedAt + access.expires_in * 1_000,
        dpopThumbprint: thumbprint,
      });
    },
  );

  const getDpopToken = Effect.fn("clientRuntime.connection.remote.getDpopToken")(function* (
    input: Parameters<RemoteEnvironmentAuthorization["Service"]["authorizeDpopHttp"]>[0],
  ) {
    const session = yield* cloudSession.identity;
    if (Option.isNone(session)) {
      return yield* sessionPending();
    }
    const identity = session.value;
    const thumbprint = yield* signer.thumbprint.pipe(
      Effect.mapError(
        () =>
          new ConnectionBlockedError({
            reason: "configuration",
            detail: "Could not load the environment authorization key.",
          }),
      ),
      Effect.withSpan("environment.authorization.dpopKey.resolve"),
    );
    const selected = yield* tokenLock.withPermits(1)(
      Effect.gen(function* () {
        yield* assertSession(identity);
        const now = yield* Clock.currentTimeMillis;
        const cached = yield* tokenStore
          .get(input.expectedEnvironmentId)
          .pipe(Effect.withSpan("environment.authorization.accessToken.cache"));
        const owner = tokenOwners.get(input.expectedEnvironmentId);
        if (
          Option.isSome(cached) &&
          cached.value.environmentId === input.expectedEnvironmentId &&
          cached.value.accountId === identity.accountId &&
          cached.value.dpopThumbprint === thumbprint &&
          cached.value.expiresAtEpochMs > now + DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS &&
          cached.value.accessToken !== input.rejectedAccessToken &&
          (owner?.accessToken !== cached.value.accessToken || owner.identity === identity)
        ) {
          tokenOwners.set(input.expectedEnvironmentId, {
            accessToken: cached.value.accessToken,
            identity,
          });
          return { token: Effect.succeed(cached.value), fromCache: true };
        }
        if (input.rejectedAccessToken !== undefined) {
          yield* removeRejectedToken(input.expectedEnvironmentId, input.rejectedAccessToken);
        }
        const pending = pendingTokens.get(input.expectedEnvironmentId);
        if (pending?.identity === identity && pending.thumbprint === thumbprint) {
          return { token: pending.token, fromCache: false };
        }

        const id = {};
        const fiber = yield* exchangeDpopToken(
          input.expectedEnvironmentId,
          thumbprint,
          identity,
        ).pipe(
          Effect.flatMap((token) =>
            tokenLock.withPermits(1)(
              Effect.gen(function* () {
                yield* assertSession(identity);
                yield* tokenStore
                  .put(token)
                  .pipe(Effect.withSpan("environment.authorization.accessToken.persist"));
                const current = yield* cloudSession.identity;
                if (Option.isNone(current) || current.value !== identity) {
                  yield* removeRejectedToken(input.expectedEnvironmentId, token.accessToken);
                  return yield* sessionChanged();
                }
                tokenOwners.set(input.expectedEnvironmentId, {
                  accessToken: token.accessToken,
                  identity,
                });
                if (pendingTokens.get(input.expectedEnvironmentId)?.id === id) {
                  pendingTokens.delete(input.expectedEnvironmentId);
                }
                return token;
              }),
            ),
          ),
          Effect.timeoutOrElse({
            duration: DPOP_AUTHORIZATION_TIMEOUT_MS,
            orElse: () =>
              Effect.fail(
                new ConnectionTransientError({
                  reason: "timeout",
                  detail: "Timed out renewing the environment credential.",
                }),
              ),
          }),
          Effect.ensuring(
            tokenLock.withPermits(1)(
              Effect.sync(() => {
                if (pendingTokens.get(input.expectedEnvironmentId)?.id === id) {
                  pendingTokens.delete(input.expectedEnvironmentId);
                }
              }),
            ),
          ),
          // One caller's timeout must not cancel renewal for other HTTP requests.
          Effect.forkIn(serviceScope),
        );
        const token = Fiber.join(fiber);
        pendingTokens.set(input.expectedEnvironmentId, { id, identity, thumbprint, token });
        return { token, fromCache: false };
      }),
    );
    yield* Effect.annotateCurrentSpan({
      "connection.remote_token_cache": selected.fromCache ? "hit" : "miss",
    });
    const token = yield* selected.token;
    yield* assertSession(identity);
    return { token, fromCache: selected.fromCache, identity };
  });

  const httpAuthorization = (
    token: TokenStore.RemoteDpopAccessToken,
    httpBaseUrl = token.endpoint.httpBaseUrl,
  ): AuthorizedRemoteHttpEnvironment => ({
    environmentId: token.environmentId,
    label: token.label,
    httpBaseUrl,
    httpAuthorization: {
      _tag: "Dpop",
      accessToken: token.accessToken,
      expiresAtEpochMs: token.expiresAtEpochMs,
    },
  });

  const authorizeDpop = Effect.fn("clientRuntime.connection.remote.authorizeDpop")(function* (
    input: Parameters<RemoteEnvironmentAuthorization["Service"]["authorizeDpop"]>[0],
  ) {
    const endpoint = input.directEndpoint;
    const descriptor =
      endpoint === undefined
        ? undefined
        : yield* verifyDirectEndpoint({
            expectedEnvironmentId: input.expectedEnvironmentId,
            httpBaseUrl: endpoint.httpBaseUrl,
            connectionMethod: "direct",
          });
    const authorized = (token: TokenStore.RemoteDpopAccessToken, socketUrl: string) => ({
      ...httpAuthorization(token, endpoint?.httpBaseUrl),
      socketUrl,
      ...(descriptor === undefined ? {} : { descriptor }),
    });
    let selected = yield* getDpopToken(input);
    if (selected.fromCache) {
      const cachedSocket = yield* createDpopSocketUrl(
        selected.token.accessToken,
        endpoint ?? selected.token.endpoint,
        "relay",
        CACHED_ENDPOINT_SOCKET_TIMEOUT_MS,
      ).pipe(Effect.result);
      if (Result.isSuccess(cachedSocket)) {
        yield* assertSession(selected.identity);
        return authorized(selected.token, cachedSocket.success);
      }
      if (cachedSocket.failure._tag === "ConnectionBlockedError") {
        return yield* mapDpopSocketError(cachedSocket.failure);
      }
      // An unreachable direct address says nothing about the token, so keep
      // it for the T3 Connect route rather than forcing a relay round trip.
      if (endpoint !== undefined && cachedSocket.failure._tag !== "EnvironmentAuthInvalidError") {
        return yield* mapDpopSocketError(cachedSocket.failure);
      }
      yield* assertSession(selected.identity);
      selected = yield* getDpopToken({
        ...input,
        rejectedAccessToken: selected.token.accessToken,
      });
    }
    const socket = yield* createDpopSocketUrl(
      selected.token.accessToken,
      endpoint ?? selected.token.endpoint,
      "relay",
    ).pipe(Effect.result);
    if (Result.isFailure(socket)) {
      if (endpoint === undefined || socket.failure._tag === "ConnectionBlockedError") {
        yield* tokenLock.withPermits(1)(
          removeRejectedToken(input.expectedEnvironmentId, selected.token.accessToken),
        );
      }
      return yield* mapDpopSocketError(socket.failure);
    }
    yield* assertSession(selected.identity);
    return authorized(selected.token, socket.success);
  });

  const directLock = (credentialId: string) => {
    let lock = directLocks.get(credentialId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      directLocks.set(credentialId, lock);
    }
    return lock;
  };

  /** Exchanges an access token for a session bound to this device's key. */
  const exchangeForDirectDpop = Effect.fn("clientRuntime.connection.remote.exchangeDirectDpop")(
    function* (httpBaseUrl: string, subjectToken: string) {
      const thumbprint = yield* signer.thumbprint.pipe(
        Effect.mapError(
          () =>
            new ConnectionBlockedError({
              reason: "configuration",
              detail: "Could not load the environment authorization key.",
            }),
        ),
      );
      const dpopProof = yield* signer
        .createProof({ method: "POST", url: environmentEndpointUrl(httpBaseUrl, "/oauth/token") })
        .pipe(
          Effect.mapError(
            () =>
              new ConnectionBlockedError({
                reason: "configuration",
                detail: "Could not create the environment authorization proof.",
              }),
          ),
        );
      const access = yield* exchangeRemoteDpopAccessToken({
        httpBaseUrl,
        credential: subjectToken,
        subjectTokenType: AuthAccessTokenType,
        dpopProof,
        clientMetadata: presentation.metadata,
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      if (access.token_type !== "DPoP") {
        return new BearerConnectionCredential({ token: access.access_token });
      }
      const issuedAt = yield* Clock.currentTimeMillis;
      return new DpopConnectionCredential({
        accessToken: access.access_token,
        expiresAtEpochMs: issuedAt + access.expires_in * 1_000,
        dpopThumbprint: thumbprint,
      });
    },
  );

  /**
   * Successors whose save failed, with the credential each replaces. The server
   * may already have revoked the replaced one, so the successor stays usable and
   * its save is retried on the next resolve.
   */
  const unsaved = new Map<
    string,
    { readonly credential: ConnectionCredential; readonly replaces: ConnectionCredential }
  >();

  const save = Effect.fn("clientRuntime.connection.remote.saveDirectCredential")(function* (
    credentialId: string,
    credential: ConnectionCredential,
    replaces: ConnectionCredential,
  ) {
    const saved = yield* credentials.put(credentialId, credential).pipe(Effect.result);
    if (Result.isSuccess(saved)) {
      unsaved.delete(credentialId);
      return;
    }
    unsaved.set(credentialId, { credential, replaces });
    yield* Effect.logWarning("Could not save the renewed environment credential.", {
      error: saved.failure,
    });
  });

  const convertBearer = Effect.fn("clientRuntime.connection.remote.convertBearer")(function* (
    input: { readonly credentialId: string; readonly httpBaseUrl: string },
    bearer: BearerConnectionCredential,
  ) {
    if (
      !input.credentialId.startsWith(PAIRED_CREDENTIAL_PREFIX) ||
      conversionChecked.has(input.credentialId)
    ) {
      return bearer;
    }
    // Without WebCrypto, as on an insecure web origin, this device can never hold a DPoP session.
    const key = yield* signer.thumbprint.pipe(Effect.result);
    if (Result.isFailure(key)) {
      conversionChecked.add(input.credentialId);
      yield* Effect.logWarning("This device cannot hold a DPoP key; keeping the bearer.", {
        error: key.failure,
      });
      return bearer;
    }
    const auth = yield* fetchRemoteAuthDescriptor({ httpBaseUrl: input.httpBaseUrl }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.option,
    );
    // An unreachable descriptor says nothing about the server, so ask again next connect.
    if (Option.isNone(auth)) return bearer;
    if (auth.value.dpopRenewal !== true) {
      conversionChecked.add(input.credentialId);
      return bearer;
    }
    const converted = yield* exchangeForDirectDpop(input.httpBaseUrl, bearer.token).pipe(
      Effect.result,
    );
    if (Result.isFailure(converted)) {
      const error = mapDpopSocketError(converted.failure, "direct");
      // A lost response may have revoked the bearer. The server answers the
      // same bearer and key again with the same DPoP session, so retry it.
      if (error._tag === "ConnectionTransientError") return yield* error;
      conversionChecked.add(input.credentialId);
      yield* Effect.logWarning("The environment kept the saved bearer credential.", {
        error: converted.failure,
      });
      return bearer;
    }
    conversionChecked.add(input.credentialId);
    yield* save(input.credentialId, converted.success, bearer);
    return converted.success;
  });

  const sameCredential = (left: ConnectionCredential, right: ConnectionCredential) =>
    left._tag === "BearerConnectionCredential"
      ? right._tag === "BearerConnectionCredential" && left.token === right.token
      : right._tag === "DpopConnectionCredential" && left.accessToken === right.accessToken;

  /** The newest credential: an unsaved successor while the store still holds what it replaced. */
  const currentCredential = Effect.fn("clientRuntime.connection.remote.currentDirectCredential")(
    function* (credentialId: string) {
      const stored = yield* credentials.get(credentialId);
      const pending = unsaved.get(credentialId);
      if (pending === undefined) return stored;
      if (Option.isNone(stored) || !sameCredential(stored.value, pending.replaces)) {
        // Pairing again or removing the connection replaced it.
        unsaved.delete(credentialId);
        return stored;
      }
      yield* save(credentialId, pending.credential, pending.replaces);
      return Option.some(pending.credential);
    },
  );

  /**
   * Returns the saved credential, renewed or converted when it needs to be.
   * One lock per credential keeps a socket renewal and an HTTP retry from
   * spending the same token twice.
   */
  const resolveDirectCredential = Effect.fn(
    "clientRuntime.connection.remote.resolveDirectCredential",
  )(function* (input: {
    readonly credentialId: string;
    readonly httpBaseUrl: string;
    readonly rejectedAccessToken?: string;
  }) {
    return yield* directLock(input.credentialId).withPermits(1)(
      Effect.gen(function* (): Effect.fn.Return<ConnectionCredential, ConnectionAttemptError> {
        const stored = yield* currentCredential(input.credentialId);
        if (Option.isNone(stored)) {
          return yield* credentialMissingError(input.credentialId);
        }
        const credential = stored.value;
        if (credential._tag === "BearerConnectionCredential") {
          return yield* convertBearer(input, credential);
        }
        const now = yield* Clock.currentTimeMillis;
        if (
          credential.accessToken !== input.rejectedAccessToken &&
          credential.expiresAtEpochMs > now + DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS
        ) {
          return credential;
        }
        const renewed = yield* exchangeForDirectDpop(
          input.httpBaseUrl,
          credential.accessToken,
        ).pipe(Effect.mapError((error) => mapDpopSocketError(error, "direct")));
        yield* save(input.credentialId, renewed, credential);
        return renewed;
      }),
    );
  });

  const directHttpAuthorization = (
    credentialId: string,
    credential: DpopConnectionCredential,
  ): AuthorizedRemoteHttpEnvironment["httpAuthorization"] => ({
    _tag: "Dpop",
    accessToken: credential.accessToken,
    expiresAtEpochMs: credential.expiresAtEpochMs,
    credentialId,
  });

  const authorizeDirect = Effect.fn("clientRuntime.connection.remote.authorizeDirect")(function* (
    input: Parameters<RemoteEnvironmentAuthorization["Service"]["authorizeDirect"]>[0],
  ) {
    const descriptor = yield* verifyDirectEndpoint({ ...input, connectionMethod: "direct" });
    const endpoint = { httpBaseUrl: input.httpBaseUrl, wsBaseUrl: input.wsBaseUrl };
    const bearer = (credential: BearerConnectionCredential) =>
      bearerSocket(
        { ...endpoint, bearerToken: credential.token, connectionMethod: "direct" },
        descriptor,
      );
    let credential = yield* resolveDirectCredential(input);
    if (credential._tag === "BearerConnectionCredential") return yield* bearer(credential);
    let socket = yield* createDpopSocketUrl(credential.accessToken, endpoint, "direct").pipe(
      Effect.result,
    );
    // The server may have ended this session early; its successor may still be granted.
    if (Result.isFailure(socket) && socket.failure._tag === "EnvironmentAuthInvalidError") {
      const renewed = yield* resolveDirectCredential({
        ...input,
        rejectedAccessToken: credential.accessToken,
      });
      if (renewed._tag === "BearerConnectionCredential") return yield* bearer(renewed);
      credential = renewed;
      socket = yield* createDpopSocketUrl(credential.accessToken, endpoint, "direct").pipe(
        Effect.result,
      );
    }
    if (Result.isFailure(socket)) {
      return yield* mapDpopSocketError(socket.failure, "direct");
    }
    return {
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: input.httpBaseUrl,
      socketUrl: socket.success,
      descriptor,
      httpAuthorization: directHttpAuthorization(input.credentialId, credential),
    };
  });

  const resolveDirectDpop = Effect.fn("clientRuntime.connection.remote.resolveDirectDpop")(
    function* (direct: DirectDpopCredential, rejectedAccessToken?: string) {
      const credential = yield* resolveDirectCredential({
        credentialId: direct.credentialId,
        httpBaseUrl: direct.httpBaseUrl,
        ...(rejectedAccessToken === undefined ? {} : { rejectedAccessToken }),
      });
      // Pairing again with an older server can replace it with a bearer.
      if (credential._tag !== "DpopConnectionCredential") {
        return yield* credentialMissingError(direct.credentialId);
      }
      return credential;
    },
  );

  return RemoteEnvironmentAuthorization.of({
    authorizeDirect,
    authorizeBearer,
    authorizeDpop: Effect.fn("environment.authorization")(function (input) {
      return authorizeDpop(input);
    }),
    // The relay tracer must wrap span creation, not just the token request.
    authorizeDpopHttp: Effect.fnUntraced(function* (input) {
      const direct = input.direct;
      if (direct !== undefined) {
        const credential = yield* resolveDirectDpop(direct, input.rejectedAccessToken);
        return {
          environmentId: input.expectedEnvironmentId,
          label: direct.label,
          httpBaseUrl: direct.httpBaseUrl,
          httpAuthorization: directHttpAuthorization(direct.credentialId, credential),
        };
      }
      return yield* getDpopToken(input).pipe(
        Effect.map(({ token }) => httpAuthorization(token)),
        Effect.withSpan("environment.authorization.http"),
        withRelayClientTracing,
      );
    }),
    // Untraced: a span here would stay open for the socket's lifetime. Each renewal has its own.
    renewDpopBeforeExpiry: Effect.fnUntraced(function* (input) {
      let expiresAtEpochMs = input.expiresAtEpochMs;
      let now = yield* Clock.currentTimeMillis;
      // Past expiry the server has closed the socket.
      while (now < expiresAtEpochMs) {
        // getDpopToken reuses a cached token until it is within the skew of expiry.
        // The floor spaces out retries and keeps a wall-clock jump from spinning.
        yield* Effect.sleep(
          Math.max(5_000, expiresAtEpochMs - DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS - now),
        );
        const direct = input.direct;
        const renewed = yield* (
          direct === undefined
            ? getDpopToken({ expectedEnvironmentId: input.expectedEnvironmentId }).pipe(
                Effect.map(({ token }) => token.expiresAtEpochMs),
                Effect.withSpan("environment.authorization.renewSocket"),
                withRelayClientTracing,
              )
            : resolveDirectDpop(direct).pipe(
                Effect.map((credential) => credential.expiresAtEpochMs),
                Effect.withSpan("environment.authorization.renewDirectSocket"),
              )
        ).pipe(
          // A relay blip retries until expiry; a blocked credential ends the loop.
          Effect.catchTags({ ConnectionTransientError: () => Effect.succeed(expiresAtEpochMs) }),
        );
        expiresAtEpochMs = Math.max(expiresAtEpochMs, renewed);
        now = yield* Clock.currentTimeMillis;
      }
    }),
  });
});

export const layer = Layer.effect(RemoteEnvironmentAuthorization, make);
