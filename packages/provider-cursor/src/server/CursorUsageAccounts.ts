import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { ProviderUsageScan } from "@t3tools/provider-core/server/usage";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  CURSOR_ACCOUNT_CACHE_FILE_NAME,
  CURSOR_ACCOUNT_TTL_MS,
  cursorFetchRange,
  decodeCursorAccountCaches,
  encodeCursorAccountCaches,
  isCursorCacheFresh,
  mergeCursorFetch,
  type CursorAccountCache,
} from "./accountCache.ts";
import type { CursorResolvedCredential } from "./accountUsage.ts";
import * as CursorAccountReader from "./CursorAccountReader.ts";

const encodeCredentialKey = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const CURSOR_ACCOUNT_READ_ERROR = "Cursor account usage could not be read.";

const decodeCacheFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>),
);

type ScanInput = {
  readonly windowStartMs: number;
  readonly retentionCutoffMs: number;
  readonly awaitRefresh: boolean;
};

export class CursorUsageAccounts extends Context.Service<
  CursorUsageAccounts,
  {
    readonly scan: (input: {
      readonly keychainUsageEnabled: boolean;
      readonly windowStartMs: number;
      readonly retentionCutoffMs: number;
      readonly awaitRefresh: boolean;
    }) => Effect.Effect<ReadonlyArray<ProviderUsageScan>>;
    readonly prepare: (keychainUsageEnabled: boolean) => Effect.Effect<{
      readonly cacheKey: string;
      readonly scan: (input: ScanInput) => Effect.Effect<ReadonlyArray<ProviderUsageScan>>;
    }>;
    /** Waits for every cache write scheduled so far, as a restart would need. */
    readonly awaitPersisted: Effect.Effect<void>;
  }
>()("@t3tools/provider-cursor/server/CursorUsageAccounts") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* ProviderHost.ProviderHost;
  const accountReader = yield* CursorAccountReader.CursorAccountReader;
  const hostEnvironment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;

  const cachePath = path.join(host.paths.stateDir, CURSOR_ACCOUNT_CACHE_FILE_NAME);
  /** Account caches by credential source and token fingerprint. */
  const caches = new Map<string, CursorAccountCache>();
  let activeCredentialKey: string | undefined;
  let preparationGeneration = 0;
  let cacheDirty = false;
  /** Per-credential failures share the cache TTL to prevent repeated requests; null means no login. */
  const failures = new Map<string, { readonly atMs: number; readonly error: string | null }>();
  /** The refresh in flight per credential, which every read joins. */
  const refreshes = new Map<string, Deferred.Deferred<void>>();

  const ensureLoaded = yield* Effect.cached(
    fileSystem.readFileString(cachePath).pipe(
      Effect.flatMap((raw) => decodeCacheFile(raw)),
      Effect.catchCause(() => Effect.succeed(null)),
      Effect.map((document) => {
        for (const [key, cache] of decodeCursorAccountCaches(document)) caches.set(key, cache);
      }),
    ),
  );

  // Serialize snapshots; clear dirty before encoding and restore it on failure so changes retry.
  const persistLock = yield* Semaphore.make(1);
  const persist = Effect.gen(function* () {
    if (!cacheDirty) return;
    cacheDirty = false;
    yield* Effect.sync(() => encodeCursorAccountCaches(caches)).pipe(
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath: cachePath, contents })),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catchCause(() =>
        Effect.sync(() => {
          cacheDirty = true;
        }),
      ),
    );
  }).pipe(persistLock.withPermit, Effect.withSpan("CursorUsageAccounts.persist"));

  const pendingPersists = new Set<Fiber.Fiber<void>>();
  const schedulePersist = Effect.forkDetach(persist).pipe(
    Effect.map((fiber) => {
      pendingPersists.add(fiber);
      fiber.addObserver(() => pendingPersists.delete(fiber));
    }),
  );
  const awaitPersisted = Effect.suspend(() => Fiber.awaitAll([...pendingPersists])).pipe(
    Effect.asVoid,
  );
  yield* Effect.addFinalizer(() => awaitPersisted);

  const refreshAccount = Effect.fn("CursorUsageAccounts.refreshAccount")(function* (
    credential: CursorResolvedCredential,
    credentialKey: string,
    retentionStartMs: number,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const fetchMissing = (cache: CursorAccountCache | undefined) => {
      const range = cursorFetchRange(cache, retentionStartMs, nowMs);
      return accountReader
        .read(credential, range.sinceMs, range.untilMs)
        .pipe(Effect.map((result) => ({ range, result })));
    };
    let base = caches.get(credentialKey);
    let fetched = yield* fetchMissing(base);
    if (activeCredentialKey !== credentialKey) return;
    // Another login's history replaces the cached account's, even if reading it fails.
    if (
      base !== undefined &&
      fetched.result.accountKey !== null &&
      fetched.result.accountKey !== base.accountKey
    ) {
      caches.delete(credentialKey);
      cacheDirty = true;
      base = undefined;
      fetched = yield* fetchMissing(base);
      if (activeCredentialKey !== credentialKey) return;
    }
    const { range, result } = fetched;
    if (result.missing || result.error !== null || result.accountKey === null) {
      failures.set(credentialKey, {
        atMs: nowMs,
        error: result.missing || result.error !== null ? result.error : CURSOR_ACCOUNT_READ_ERROR,
      });
      yield* schedulePersist;
      return;
    }
    const merged = mergeCursorFetch(
      base,
      result.accountKey,
      range,
      result.records,
      nowMs,
      retentionStartMs,
    );
    caches.set(credentialKey, merged.cache);
    failures.delete(credentialKey);
    if (merged.changed) cacheDirty = true;
    yield* schedulePersist;
  });

  const startRefresh = (
    credential: CursorResolvedCredential,
    credentialKey: string,
    retentionStartMs: number,
  ) =>
    // Enroll and fork atomically so interruption cannot strand a registered refresh.
    Effect.uninterruptible(
      Effect.gen(function* () {
        const current = refreshes.get(credentialKey);
        if (current !== undefined) return current;
        const done = Deferred.makeUnsafe<void>();
        refreshes.set(credentialKey, done);
        // Detached: a departing client must not cancel a fetch later reads reuse.
        yield* refreshAccount(credential, credentialKey, retentionStartMs).pipe(
          Effect.catchCause(() =>
            Clock.currentTimeMillis.pipe(
              Effect.map((atMs) => {
                if (activeCredentialKey === credentialKey)
                  failures.set(credentialKey, { atMs, error: CURSOR_ACCOUNT_READ_ERROR });
              }),
            ),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              refreshes.delete(credentialKey);
              return Deferred.succeed(done, undefined);
            }),
          ),
          Effect.forkDetach,
        );
        return done;
      }),
    );

  const accountSource = Effect.fn("CursorUsageAccounts.accountSource")(function* (
    credential: CursorResolvedCredential,
    credentialKey: string,
    authPath: string,
    windowStartMs: number,
    retentionStartMs: number,
    awaitRefresh: boolean,
  ) {
    if (credential.kind === "unavailable") {
      if (credential.missing && credential.error === null) return null;
      return {
        dir: authPath,
        files: null,
        message: credential.error ?? CURSOR_ACCOUNT_READ_ERROR,
      } satisfies ProviderUsageScan;
    }
    const nowMs = yield* Clock.currentTimeMillis;
    const recentFailure = failures.get(credentialKey);
    let refreshing = false;
    if (
      (recentFailure === undefined || nowMs - recentFailure.atMs >= CURSOR_ACCOUNT_TTL_MS) &&
      !isCursorCacheFresh(caches.get(credentialKey), nowMs)
    ) {
      const refresh = yield* startRefresh(credential, credentialKey, retentionStartMs);
      if (awaitRefresh) yield* Deferred.await(refresh);
      else refreshing = true;
    }

    const cache = caches.get(credentialKey);
    const failure = refreshing ? undefined : failures.get(credentialKey);
    const failureMessage = failure === undefined ? undefined : failure.error;
    if (failureMessage === null) return null;
    if (cache === undefined) {
      return {
        dir: authPath,
        // Never combine a local fallback with another server's account-wide history.
        ...(refreshing
          ? { files: [], refreshing: true }
          : { files: null, message: failureMessage ?? CURSOR_ACCOUNT_READ_ERROR }),
      } satisfies ProviderUsageScan;
    }
    // Account history spans machines; a stable fingerprint prevents duplicate environment counts.
    const source = `cursor-account:${cache.accountKey}`;
    return {
      dir: source,
      hostId: "cursor.com",
      volumeId: cache.accountKey,
      files: [
        {
          path: source,
          records: cache.records.filter((record) => record.timestampMs >= windowStartMs),
        },
      ],
      ...(failureMessage === undefined
        ? { status: "ok" }
        : { status: "partial", message: failureMessage }),
      ...(refreshing ? { refreshing: true } : {}),
    } satisfies ProviderUsageScan;
  });

  const prepare: CursorUsageAccounts["Service"]["prepare"] = Effect.fn(
    "CursorUsageAccounts.prepare",
  )(function* (keychainUsageEnabled) {
    const generation = ++preparationGeneration;
    const home = yield* HostProcess.HomeDirectory;
    const userHome =
      (platform === "win32" ? hostEnvironment["USERPROFILE"] : hostEnvironment["HOME"]) || home;
    const configHome = hostEnvironment["XDG_CONFIG_HOME"]?.trim();
    const cursorHome =
      platform === "darwin"
        ? path.join(userHome, "Library", "Application Support")
        : platform === "win32"
          ? hostEnvironment["APPDATA"] || path.join(userHome, "AppData", "Roaming")
          : configHome && path.isAbsolute(configHome)
            ? configHome
            : path.join(userHome, ".config");
    const authPath =
      platform === "darwin"
        ? path.join(userHome, ".cursor", "auth.json")
        : path.join(cursorHome, platform === "win32" ? "Cursor" : "cursor", "auth.json");
    const credentialStore = hostEnvironment["AGENT_CLI_CREDENTIAL_STORE"];
    const loginUnavailable =
      Boolean(hostEnvironment["CURSOR_AUTH_TOKEN"]?.trim()) ||
      Boolean(hostEnvironment["CURSOR_API_KEY"]?.trim()) ||
      credentialStore === "memory";
    const useKeychain = platform === "darwin" && credentialStore !== "file";
    if (useKeychain && !loginUnavailable && !keychainUsageEnabled) {
      return {
        cacheKey: "keychain-disabled",
        scan: () =>
          Effect.succeed([
            {
              dir: authPath,
              volumeId: "",
              files: null,
              message: "Cursor account usage is off on this environment.",
              action: "enableCursorKeychain",
            },
          ]),
      };
    }
    if (loginUnavailable) {
      return {
        cacheKey: "login-unavailable",
        scan: () =>
          Effect.succeed([
            {
              dir: authPath,
              files: null,
              message: "Cursor account history needs a Cursor CLI login on this server.",
            },
          ]),
      };
    }
    yield* ensureLoaded;
    const sourceKey = useKeychain ? "keychain" : authPath;
    const resolved = yield* accountReader.resolve(useKeychain ? { kind: "keychain" } : authPath);
    const cacheKey =
      resolved.kind === "token" ? encodeCredentialKey([sourceKey, resolved.fingerprint]) : "";
    // A slower credential resolution keeps its request's snapshot, but cannot
    // replace the identity observed by a newer preparation.
    if (generation === preparationGeneration) {
      activeCredentialKey = cacheKey;
      const prefix = encodeCredentialKey([sourceKey]).slice(0, -1) + ",";
      for (const key of caches.keys()) {
        if (key !== cacheKey && (key === sourceKey || key.startsWith(prefix))) {
          caches.delete(key);
          cacheDirty = true;
        }
      }
      for (const key of failures.keys()) {
        if (key !== cacheKey && (key === sourceKey || key.startsWith(prefix))) failures.delete(key);
      }
      if (cacheDirty) yield* schedulePersist;
    }
    return {
      cacheKey: resolved.kind === "token" ? cacheKey : encodeCredentialKey(resolved),
      scan: Effect.fn("CursorUsageAccounts.scanPrepared")(function* ({
        windowStartMs,
        retentionCutoffMs,
        awaitRefresh,
      }: ScanInput) {
        const source = yield* accountSource(
          resolved,
          cacheKey,
          authPath,
          windowStartMs,
          retentionCutoffMs,
          awaitRefresh,
        );
        return source === null ? [] : [source];
      }),
    };
  });

  const scan: CursorUsageAccounts["Service"]["scan"] = (input) =>
    prepare(input.keychainUsageEnabled).pipe(Effect.flatMap((snapshot) => snapshot.scan(input)));
  return CursorUsageAccounts.of({ scan, prepare, awaitPersisted });
});

export const layer = Layer.effect(CursorUsageAccounts, make);
