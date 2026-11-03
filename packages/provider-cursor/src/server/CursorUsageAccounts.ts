import type { ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { ProviderUsageScan } from "@t3tools/provider-core/server/usage";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
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
  type CursorCredentialSource,
} from "./accountCache.ts";
import type { CursorResolvedCredential } from "./accountUsage.ts";
import * as CursorAccountReader from "./CursorAccountReader.ts";
import { readStoredCursorApiKey } from "./credentialStore.ts";

const encodeCredentialKey = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const CURSOR_ACCOUNT_READ_ERROR = "Cursor account usage could not be read.";

const decodeCacheFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>),
);

type PrepareInput = {
  readonly instances: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly environment: NodeJS.ProcessEnv;
  }>;
  readonly keychainUsageEnabled: boolean;
};

type ScanInput = {
  readonly windowStartMs: number;
  readonly retentionCutoffMs: number;
  readonly awaitRefresh: boolean;
};

export class CursorUsageAccounts extends Context.Service<
  CursorUsageAccounts,
  {
    readonly scan: (
      input: PrepareInput & ScanInput,
    ) => Effect.Effect<ReadonlyArray<ProviderUsageScan>>;
    readonly prepare: (input: PrepareInput) => Effect.Effect<{
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
  const digest = yield* Digest.Digest;

  const cachePath = path.join(host.paths.stateDir, CURSOR_ACCOUNT_CACHE_FILE_NAME);
  /** Account caches by credential source and token or API-key fingerprint. */
  const caches = new Map<string, CursorAccountCache>();
  /** Credentials the latest preparation observed; refreshes for any other are discarded. */
  let activeCredentialKeys: ReadonlySet<string> = new Set();
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
    credential: CursorCredentialSource | CursorResolvedCredential,
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
    if (!activeCredentialKeys.has(credentialKey)) return;
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
      if (!activeCredentialKeys.has(credentialKey)) return;
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
    credential: CursorCredentialSource | CursorResolvedCredential,
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
                if (activeCredentialKeys.has(credentialKey))
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
    credential: CursorCredentialSource | CursorResolvedCredential,
    credentialKey: string,
    authPath: string,
    windowStartMs: number,
    retentionStartMs: number,
    awaitRefresh: boolean,
  ) {
    if (typeof credential !== "string" && credential.kind === "unavailable") {
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

  type PreparedScan = {
    readonly cacheKey: string;
    /** Credentials whose refreshes this snapshot keeps. */
    readonly credentialKeys: ReadonlyArray<string>;
    readonly scan: (input: ScanInput) => Effect.Effect<ReadonlyArray<ProviderUsageScan>>;
  };

  const notice = (cacheKey: string, source: ProviderUsageScan): PreparedScan => ({
    cacheKey,
    credentialKeys: [],
    scan: () => Effect.succeed([source]),
  });

  const prepareApiKeys = Effect.fn("CursorUsageAccounts.prepareApiKeys")(function* (
    apiKeys: ReadonlyArray<string>,
    authPath: string,
  ) {
    yield* ensureLoaded;
    const keyed = yield* Effect.forEach(apiKeys, (apiKey) =>
      digest.digest(Digest.sha256, new TextEncoder().encode(apiKey)).pipe(
        // A fingerprint, so a replaced key never reads the previous account's cache.
        Effect.map((hash) => ({ apiKey, credentialKey: `api-key:${Hex.encode(hash)}` })),
      ),
    );
    const credentialKeys = keyed.map(({ credentialKey }) => credentialKey).toSorted();
    return {
      cacheKey: encodeCredentialKey(credentialKeys),
      credentialKeys,
      scan: ({ windowStartMs, retentionCutoffMs, awaitRefresh }: ScanInput) =>
        Effect.forEach(keyed, ({ apiKey, credentialKey }) =>
          accountSource(
            { kind: "apiKey", apiKey },
            credentialKey,
            authPath,
            windowStartMs,
            retentionCutoffMs,
            awaitRefresh,
          ),
        ).pipe(Effect.map((sources) => sources.filter((source) => source !== null))),
    } satisfies PreparedScan;
  });

  const prepareLogin = Effect.fn("CursorUsageAccounts.prepareLogin")(function* (
    keychainUsageEnabled: boolean,
    authPath: string,
    generation: number,
  ): Effect.fn.Return<PreparedScan> {
    const credentialStore = hostEnvironment["AGENT_CLI_CREDENTIAL_STORE"];
    const loginUnavailable =
      Boolean(hostEnvironment["CURSOR_AUTH_TOKEN"]?.trim()) || credentialStore === "memory";
    const useKeychain = platform === "darwin" && credentialStore !== "file";
    if (useKeychain && !loginUnavailable && !keychainUsageEnabled) {
      return notice("keychain-disabled", {
        dir: authPath,
        volumeId: "",
        files: null,
        message: "Cursor account usage is off on this environment.",
        action: "enableCursorKeychain",
      });
    }
    if (loginUnavailable) {
      return notice("login-unavailable", {
        dir: authPath,
        files: null,
        message: "Cursor account history needs a Cursor CLI login on this server.",
      });
    }
    // A Keychain login outlives an uninstalled Cursor, so it also needs Cursor's local directory.
    if (
      useKeychain &&
      !(yield* fileSystem.exists(path.dirname(authPath)).pipe(Effect.orElseSucceed(() => true)))
    ) {
      return {
        cacheKey: "not-installed",
        credentialKeys: [],
        scan: () => Effect.succeed([]),
      } satisfies PreparedScan;
    }
    yield* ensureLoaded;
    const sourceKey = useKeychain ? "keychain" : authPath;
    const resolved = yield* accountReader.resolve(useKeychain ? { kind: "keychain" } : authPath);
    const cacheKey =
      resolved.kind === "token" ? encodeCredentialKey([sourceKey, resolved.fingerprint]) : "";
    // A slower credential resolution keeps its request's snapshot, but cannot
    // drop the caches of the identity observed by a newer preparation.
    if (generation === preparationGeneration) {
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
      credentialKeys: [cacheKey],
      scan: ({ windowStartMs, retentionCutoffMs, awaitRefresh }: ScanInput) =>
        accountSource(
          resolved,
          cacheKey,
          authPath,
          windowStartMs,
          retentionCutoffMs,
          awaitRefresh,
        ).pipe(Effect.map((source) => (source === null ? [] : [source]))),
    } satisfies PreparedScan;
  });

  const prepare: CursorUsageAccounts["Service"]["prepare"] = Effect.fn(
    "CursorUsageAccounts.prepare",
  )(function* ({ instances, keychainUsageEnabled }) {
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

    // T3's Cursor sign-in and CURSOR_API_KEY name the account the agent uses, so they win.
    const apiKeys = yield* Effect.forEach(instances, ({ instanceId, environment }) =>
      environment.CURSOR_API_KEY?.trim()
        ? Effect.succeed(environment.CURSOR_API_KEY.trim())
        : readStoredCursorApiKey(instanceId).pipe(
            Effect.provideService(ProviderHost.ProviderHost, host),
            Effect.orElseSucceed(() => undefined),
          ),
    );
    const uniqueApiKeys = [...new Set(apiKeys.filter((apiKey) => apiKey !== undefined))];
    // An instance without a key runs on the CLI login, so that account still counts.
    const usesLogin = uniqueApiKeys.length === 0 || apiKeys.includes(undefined);
    const prepared: ReadonlyArray<PreparedScan> = [
      ...(uniqueApiKeys.length > 0 ? [yield* prepareApiKeys(uniqueApiKeys, authPath)] : []),
      ...(usesLogin ? [yield* prepareLogin(keychainUsageEnabled, authPath, generation)] : []),
    ];
    if (generation === preparationGeneration) {
      activeCredentialKeys = new Set(prepared.flatMap(({ credentialKeys }) => credentialKeys));
    }
    return {
      cacheKey: encodeCredentialKey(prepared.map(({ cacheKey }) => cacheKey)),
      scan: Effect.fn("CursorUsageAccounts.scanPrepared")(function* (input: ScanInput) {
        const sources = (yield* Effect.forEach(prepared, ({ scan }) => scan(input))).flat();
        // Credentials for one account share its source, and a repeated source would count
        // sessions twice. A failed credential can hold older records, so a current read wins,
        // then a refresh the client must follow up on.
        const rank = (source: ProviderUsageScan) =>
          source.status === "ok" ? 2 : source.refreshing ? 1 : 0;
        const byAccount = new Map<string, ProviderUsageScan>();
        for (const source of sources) {
          const kept = byAccount.get(source.dir);
          if (kept === undefined || rank(source) > rank(kept)) byAccount.set(source.dir, source);
        }
        return [...byAccount.values()];
      }),
    };
  });

  const scan: CursorUsageAccounts["Service"]["scan"] = (input) =>
    prepare(input).pipe(Effect.flatMap((snapshot) => snapshot.scan(input)));
  return CursorUsageAccounts.of({ scan, prepare, awaitPersisted });
});

export const layer = Layer.effect(CursorUsageAccounts, make);
