import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  BearerConnectionCredential,
  type ConnectionCredential,
  type ConnectionRegistration,
  ConnectionProfile,
  DpopConnectionCredential,
  sameConnectionCredential,
} from "../connection/catalog.ts";
import * as CredentialStore from "../connection/credentialStore.ts";
import {
  type ConnectionAttemptError,
  type ConnectionTarget,
  PersistedConnectionTarget,
} from "../connection/model.ts";
import * as TokenStore from "../authorization/tokenStore.ts";
import { StoredPullRequestRoutingPermission } from "../connection/pullRequestRoutingPermissions.ts";

const StoredConnectionCredential = Schema.Struct({
  connectionId: Schema.String,
  credential: BearerConnectionCredential,
});

const StoredDpopConnectionCredential = Schema.Struct({
  connectionId: Schema.String,
  credential: DpopConnectionCredential,
});

export const ConnectionCatalogDocument = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  targets: Schema.Array(PersistedConnectionTarget),
  profiles: Schema.Array(ConnectionProfile),
  credentials: Schema.Array(StoredConnectionCredential),
  // Kept apart from `credentials`: older builds decode that list as bearer only,
  // and a catalog they cannot decode is discarded.
  dpopCredentials: Schema.optionalKey(Schema.Array(StoredDpopConnectionCredential)),
  remoteDpopTokens: Schema.Array(TokenStore.RemoteDpopAccessToken),
  // Pull request routing grants. The field name predates the rename and stays, so older and
  // newer clients sharing this document keep reading and revoking the same grants.
  githubRoutingPermissions: Schema.optionalKey(Schema.Array(StoredPullRequestRoutingPermission)),
  disabledEnvironmentIds: Schema.Array(EnvironmentId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
});
export type ConnectionCatalogDocument = typeof ConnectionCatalogDocument.Type;

export const EMPTY_CONNECTION_CATALOG_DOCUMENT: ConnectionCatalogDocument = Object.freeze({
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
  disabledEnvironmentIds: [],
});

export function replaceCatalogValue<A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
  next: A,
): ReadonlyArray<A> {
  const nextKey = key(next);
  return [...values.filter((value) => key(value) !== nextKey), next];
}

export function removeCatalogValue<A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
  removedKey: string,
): ReadonlyArray<A> {
  return values.filter((value) => key(value) !== removedKey);
}

export function catalogCredential(
  document: ConnectionCatalogDocument,
  connectionId: string,
): ConnectionCredential | undefined {
  return (
    document.credentials.find((value) => value.connectionId === connectionId)?.credential ??
    document.dpopCredentials?.find((value) => value.connectionId === connectionId)?.credential
  );
}

function removeCatalogCredential(
  document: ConnectionCatalogDocument,
  connectionId: string,
): ConnectionCatalogDocument {
  return removeCatalogCredentials(document, new Set([connectionId]));
}

function removeCatalogCredentials(
  document: ConnectionCatalogDocument,
  connectionIds: ReadonlySet<string>,
): ConnectionCatalogDocument {
  const { dpopCredentials, ...rest } = document;
  const keptDpop = dpopCredentials?.filter((value) => !connectionIds.has(value.connectionId));
  return {
    ...rest,
    credentials: document.credentials.filter((value) => !connectionIds.has(value.connectionId)),
    ...(keptDpop === undefined || keptDpop.length === 0 ? {} : { dpopCredentials: keptDpop }),
  };
}

export function putCatalogCredential(
  document: ConnectionCatalogDocument,
  connectionId: string,
  credential: ConnectionCredential,
): ConnectionCatalogDocument {
  const next = removeCatalogCredential(document, connectionId);
  switch (credential._tag) {
    case "BearerConnectionCredential":
      return { ...next, credentials: [...next.credentials, { connectionId, credential }] };
    case "DpopConnectionCredential":
      return {
        ...next,
        dpopCredentials: [...(next.dpopCredentials ?? []), { connectionId, credential }],
      };
  }
}

/** The credential store over a saved catalog, shared by the web and mobile clients. */
export function makeCatalogCredentialStore<E extends ConnectionAttemptError>(catalog: {
  readonly read: Effect.Effect<ConnectionCatalogDocument, E>;
  readonly update: (
    transform: (document: ConnectionCatalogDocument) => ConnectionCatalogDocument,
  ) => Effect.Effect<void, E>;
}) {
  return CredentialStore.make({
    get: (connectionId) =>
      catalog.read.pipe(
        Effect.map((document) => Option.fromUndefinedOr(catalogCredential(document, connectionId))),
      ),
    put: (connectionId, credential, replaces) =>
      catalog.update((document) => {
        const current = catalogCredential(document, connectionId);
        return replaces !== undefined &&
          (current === undefined || !sameConnectionCredential(current, replaces))
          ? document
          : putCatalogCredential(document, connectionId, credential);
      }),
    remove: (connectionId) =>
      catalog.update((document) => removeCatalogCredential(document, connectionId)),
  });
}

function connectionIdOf(target: ConnectionTarget): string | null {
  switch (target._tag) {
    case "PrimaryConnectionTarget":
    case "RelayConnectionTarget":
      return null;
    case "BearerConnectionTarget":
    case "SshConnectionTarget":
      return target.connectionId;
  }
}

function routeKey(target: ConnectionTarget): string {
  return connectionIdOf(target) ?? target._tag;
}

function removeRouteMetadata(
  document: ConnectionCatalogDocument,
  removed: ReadonlyArray<ConnectionTarget>,
): ConnectionCatalogDocument {
  const connectionIds = new Set(removed.flatMap((target) => connectionIdOf(target) ?? []));
  const relayRemoved = removed.some((target) => target._tag === "RelayConnectionTarget");
  const environmentIds = new Set(removed.map((target) => target.environmentId));
  return {
    ...removeCatalogCredentials(document, connectionIds),
    profiles: document.profiles.filter((value) => !connectionIds.has(value.connectionId)),
    remoteDpopTokens: relayRemoved
      ? document.remoteDpopTokens.filter((value) => !environmentIds.has(value.environmentId))
      : document.remoteDpopTokens,
  };
}

export function catalogRoutes(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
): ReadonlyArray<PersistedConnectionTarget> {
  return document.targets.filter((target) => target.environmentId === environmentId);
}

/**
 * Records owned by a dropped route go with it; the environment keeps its
 * position in the catalog. An empty list leaves the environment's other records
 * in place; use `removeConnectionFromCatalog` to forget the environment.
 */
export function setRoutesInCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
  routes: ReadonlyArray<PersistedConnectionTarget>,
): ConnectionCatalogDocument {
  const kept = new Set(routes.map(routeKey));
  const dropped = catalogRoutes(document, environmentId).filter(
    (target) => !kept.has(routeKey(target)),
  );
  const firstIndex = document.targets.findIndex((target) => target.environmentId === environmentId);
  const others = document.targets.filter((target) => target.environmentId !== environmentId);
  const insertAt =
    firstIndex === -1
      ? others.length
      : document.targets.slice(0, firstIndex).filter((t) => t.environmentId !== environmentId)
          .length;
  return {
    ...removeRouteMetadata(document, dropped),
    targets: [...others.slice(0, insertAt), ...routes, ...others.slice(insertAt)],
  };
}

export function registerConnectionInCatalog(
  document: ConnectionCatalogDocument,
  registration: ConnectionRegistration,
  routes: ReadonlyArray<PersistedConnectionTarget> = [registration.target],
): ConnectionCatalogDocument {
  const next = setRoutesInCatalog(document, registration.target.environmentId, routes);

  switch (registration._tag) {
    case "RelayConnectionRegistration":
      return next;
    case "BearerConnectionRegistration":
    case "SshConnectionRegistration":
      return {
        ...putCatalogCredential(next, registration.target.connectionId, registration.credential),
        profiles: replaceCatalogValue(
          next.profiles,
          (value) => value.connectionId,
          registration.profile,
        ),
      };
  }
}

export function removeConnectionFromCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
): ConnectionCatalogDocument {
  const next = setRoutesInCatalog(document, environmentId, []);
  return {
    ...next,
    remoteDpopTokens: removeCatalogValue(
      next.remoteDpopTokens,
      (value) => value.environmentId,
      environmentId,
    ),
    disabledEnvironmentIds: removeCatalogValue(
      next.disabledEnvironmentIds,
      (value) => value,
      environmentId,
    ),
    ...(next.githubRoutingPermissions === undefined
      ? {}
      : {
          githubRoutingPermissions: next.githubRoutingPermissions.filter(
            (permission) => permission.environmentId !== environmentId,
          ),
        }),
  };
}

export function setConnectionEnabledInCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
  enabled: boolean,
): ConnectionCatalogDocument {
  const registered = document.targets.some((target) => target.environmentId === environmentId);
  const without = removeCatalogValue(
    document.disabledEnvironmentIds,
    (value) => value,
    environmentId,
  );
  return {
    ...document,
    disabledEnvironmentIds: registered && !enabled ? [...without, environmentId] : without,
  };
}

export function putRemoteDpopTokenInCatalog(
  document: ConnectionCatalogDocument,
  token: TokenStore.RemoteDpopAccessToken,
): ConnectionCatalogDocument {
  const registered = document.targets.some(
    (target) =>
      target._tag === "RelayConnectionTarget" && target.environmentId === token.environmentId,
  );
  if (!registered) {
    return document;
  }
  return {
    ...document,
    remoteDpopTokens: replaceCatalogValue(
      document.remoteDpopTokens,
      (value) => value.environmentId,
      token,
    ),
  };
}
