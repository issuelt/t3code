import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  type ConnectionTarget,
  RelayConnectionTarget,
} from "../connection/model.ts";
import * as ConnectionResolver from "../connection/resolver.ts";
import * as RpcHttp from "../rpc/http.ts";
import { answerRuntimeRequestOverRoutes } from "./runtimeRequestHttp.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-answer");
const LAN = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Workstation",
  connectionId: "lan",
});
const RELAY = new RelayConnectionTarget({ environmentId: ENVIRONMENT_ID, label: "Workstation" });
const ANSWER = {
  threadId: ThreadId.make("thread-answer"),
  requestId: RuntimeRequestId.make("request-answer"),
  decision: "accept",
} as const;

const httpBaseUrl = (target: ConnectionTarget) =>
  target._tag === "RelayConnectionTarget"
    ? "https://relay.example.test"
    : "https://lan.example.test";

const routes = (alternate: boolean): ConnectionCatalogEntry => ({
  target: LAN,
  profile: Option.none(),
  enabled: true,
  ...(alternate ? { alternateRoutes: [{ target: RELAY, profile: Option.none() }] } : {}),
});

const layer = (input: {
  readonly prepareDelay?: (target: ConnectionTarget) => Duration.Input;
  readonly fetch: (url: string, body: string) => Promise<Response>;
}) =>
  Layer.mergeAll(
    Layer.succeed(
      ConnectionResolver.ConnectionResolver,
      ConnectionResolver.ConnectionResolver.of({
        prepare: (entry) =>
          Effect.sleep(input.prepareDelay?.(entry.target) ?? "0 millis").pipe(
            Effect.as({
              environmentId: ENVIRONMENT_ID,
              label: entry.target.label,
              httpBaseUrl: httpBaseUrl(entry.target),
              socketUrl: httpBaseUrl(entry.target).replace("https:", "wss:"),
              httpAuthorization: null,
              target: entry.target,
            }),
          ),
        prepareForUpdate: () =>
          Effect.fail(new ConnectionTransientError({ reason: "network", detail: "unused" })),
      }),
    ),
    Layer.succeed(
      SecureRandom.SecureRandom,
      SecureRandom.make((size) => new Uint8Array(size).fill(7)),
    ),
    RpcHttp.layerRemoteHttpClient(async (url, init) =>
      input.fetch(String(url), await new Request(url, init).text()),
    ),
  );

describe("answerRuntimeRequestOverRoutes", () => {
  it.effect("answers through the next route with the same command id", () => {
    const sent: Array<{ readonly url: string; readonly commandId: unknown }> = [];
    return Effect.gen(function* () {
      const outcome = yield* answerRuntimeRequestOverRoutes(routes(true), ANSWER);
      assert.deepStrictEqual(outcome, {
        _tag: "Answered",
        result: { _tag: "Responded", sequence: 3 },
      });
      assert.deepStrictEqual(sent.map(({ url }) => new URL(url).host).sort(), [
        "lan.example.test",
        "relay.example.test",
      ]);
      assert.strictEqual(sent[0]?.commandId, sent[1]?.commandId);
    }).pipe(
      Effect.provide(
        layer({
          fetch: (url, body) => {
            sent.push({ url, commandId: JSON.parse(body).commandId });
            return Promise.resolve(
              url.startsWith("https://lan.")
                ? new Response("unavailable", { status: 502 })
                : Response.json({ _tag: "Responded", sequence: 3 }),
            );
          },
        }),
      ),
    );
  });

  it.effect("spends one 20 s budget on preparing and answering", () =>
    Effect.gen(function* () {
      const answer = yield* Effect.forkChild(answerRuntimeRequestOverRoutes(routes(false), ANSWER));
      yield* TestClock.adjust("20 seconds");
      // Done at 20 s even though preparing took 15 s and the request never answered.
      assert.isDefined(answer.pollUnsafe());
      assert.deepStrictEqual(yield* Fiber.join(answer), {
        _tag: "Unreachable",
        environmentLabel: "Workstation",
      });
    }).pipe(
      Effect.provide(
        layer({ prepareDelay: () => "15 seconds", fetch: () => new Promise<Response>(() => {}) }),
      ),
    ),
  );

  it.effect("races the routes, so a hung route does not hold back a working one", () =>
    Effect.gen(function* () {
      const answer = yield* Effect.forkChild(answerRuntimeRequestOverRoutes(routes(true), ANSWER));
      yield* TestClock.adjust("1 second");
      assert.isDefined(answer.pollUnsafe());
      assert.deepStrictEqual(yield* Fiber.join(answer), {
        _tag: "Answered",
        result: { _tag: "AlreadyResolved", status: "resolved" },
      });
    }).pipe(
      Effect.provide(
        layer({
          fetch: (url) =>
            url.startsWith("https://lan.")
              ? new Promise<Response>(() => {})
              : Promise.resolve(Response.json({ _tag: "AlreadyResolved", status: "resolved" })),
        }),
      ),
    ),
  );

  it.effect("lets a route that can answer beat a faster route paired with fewer scopes", () =>
    Effect.gen(function* () {
      const answer = yield* Effect.forkChild(answerRuntimeRequestOverRoutes(routes(true), ANSWER));
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(yield* Fiber.join(answer), {
        _tag: "Answered",
        result: { _tag: "Responded", sequence: 4 },
      });
    }).pipe(
      Effect.provide(
        layer({
          prepareDelay: (target) =>
            target._tag === "RelayConnectionTarget" ? "500 millis" : "0 millis",
          fetch: (url) =>
            url.startsWith("https://lan.")
              ? Promise.resolve(
                  Response.json(
                    {
                      _tag: "EnvironmentScopeRequiredError",
                      code: "insufficient_scope",
                      requiredScope: "orchestration:operate",
                      traceId: "trace",
                    },
                    { status: 403 },
                  ),
                )
              : Promise.resolve(Response.json({ _tag: "Responded", sequence: 4 })),
        }),
      ),
    ),
  );

  it.effect.each([
    [
      "a missing scope",
      403,
      {
        _tag: "EnvironmentScopeRequiredError",
        code: "insufficient_scope",
        requiredScope: "orchestration:operate",
        traceId: "trace",
      },
      "not_permitted",
    ],
    [
      "a thread that is gone",
      404,
      {
        _tag: "EnvironmentResourceNotFoundError",
        code: "not_found",
        reason: "thread_not_found",
        traceId: "trace",
      },
      "unanswerable",
    ],
    [
      "a request it cannot answer",
      400,
      {
        _tag: "EnvironmentRequestInvalidError",
        code: "invalid_request",
        reason: "invalid_command",
        traceId: "trace",
      },
      "unanswerable",
    ],
  ] as const)("reports %s as rejected, not unreachable", ([, status, body, reason]) =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* answerRuntimeRequestOverRoutes(routes(false), ANSWER), {
        _tag: "Rejected",
        reason,
      });
    }).pipe(
      Effect.provide(layer({ fetch: () => Promise.resolve(Response.json(body, { status })) })),
    ),
  );
});
