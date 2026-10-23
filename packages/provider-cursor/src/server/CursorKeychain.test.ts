import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as CursorKeychain from "./CursorKeychain.ts";

describe("CursorKeychain freshness", () => {
  it.effect("shares fresh reads and updates the cache after login changes and logout", () =>
    Effect.gen(function* () {
      let reads = 0;
      let token: string | null = "token-a";
      const started = yield* Deferred.make<void>();
      const allow = yield* Deferred.make<void>();
      const keychain = CursorKeychain.make(
        Effect.gen(function* () {
          reads++;
          if (reads === 2) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(allow);
          }
          return token;
        }),
      );
      assert.strictEqual(yield* keychain.accessToken, "token-a");
      token = "token-b";
      const first = yield* CursorKeychain.freshAccessToken(keychain).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      // Both callers enroll before the blocked native read completes.
      const second = yield* CursorKeychain.freshAccessToken(keychain).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      assert.strictEqual(yield* keychain.accessToken, "token-a");
      yield* Deferred.succeed(allow, undefined);
      assert.strictEqual(yield* Fiber.join(first), "token-b");
      assert.strictEqual(yield* Fiber.join(second), "token-b");
      assert.strictEqual(yield* keychain.accessToken, "token-b");
      assert.strictEqual(reads, 2);
      token = null;
      assert.isNull(yield* CursorKeychain.freshAccessToken(keychain));
      assert.isNull(yield* keychain.accessToken);
    }),
  );

  it.effect.each([false, true])(
    "gives up on an unanswered prompt and reuses it on the next read with fresh %s",
    (fresh) =>
      Effect.gen(function* () {
        let reads = 0;
        const allow = yield* Deferred.make<string>();
        const keychain = CursorKeychain.make(
          Effect.suspend(() => {
            reads++;
            return Deferred.await(allow);
          }),
          Duration.millis(1),
        );
        const read = fresh ? CursorKeychain.freshAccessToken(keychain) : keychain.accessToken;
        const timedOut = yield* read.pipe(Effect.forkChild);
        yield* TestClock.adjust(Duration.millis(1));
        const error = yield* Fiber.join(timedOut).pipe(Effect.flip);
        assert.isTrue(CursorKeychain.isCursorKeychainTimeoutError(error));
        const retry = yield* read.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(allow, "token");
        assert.strictEqual(yield* Fiber.join(retry), "token");
        assert.strictEqual(reads, 1);
      }),
  );
});
