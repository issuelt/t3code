import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type FleetHostRequest,
  type FleetInvokeInput,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as FleetBroker from "./FleetBroker.ts";

const hub = EnvironmentId.make("hub");
const studio = EnvironmentId.make("studio");
const layer = FleetBroker.layer.pipe(Layer.provide(NodeCrypto.layer));

const invoke: FleetInvokeInput = {
  actor: { environmentId: hub, threadId: ThreadId.make("home") },
  request: { op: "requests.list", input: { threadId: ThreadId.make("t") } },
};

// Keeps the desktop's stream open, as a live renderer does, and hands back the first request.
const serve = (requests: Stream.Stream<FleetHostRequest>) =>
  Effect.gen(function* () {
    const first = yield* Deferred.make<FleetHostRequest>();
    yield* Stream.runForEach(requests, (request) => Deferred.succeed(first, request)).pipe(
      Effect.forkScoped({ startImmediately: true }),
    );
    return first;
  });

const host = (clientId: string, connected = true, mcpRelay = true) => ({
  mcpRelay,
  clientId,
  environments: [{ environmentId: studio, label: "Studio", connected }],
});

it.effect("fails fast when no desktop window relays", () =>
  Effect.gen(function* () {
    const broker = yield* FleetBroker.FleetBroker;
    const error = yield* broker.invoke(studio, invoke).pipe(Effect.asVoid, Effect.flip);
    expect(error.code).toBe("environment_unavailable");
  }).pipe(Effect.provide(layer)),
);

it.effect("relays a call through the desktop and decodes the answer", () =>
  Effect.gen(function* () {
    const broker = yield* FleetBroker.FleetBroker;
    const firstRequest = yield* serve(yield* broker.connect(host("desktop")));
    const call = yield* broker.invoke(studio, invoke).pipe(Effect.forkScoped);
    const request = yield* Deferred.await(firstRequest);
    expect(request).toMatchObject({ environmentId: studio, invoke });
    yield* broker.respond({ requestId: request.requestId, result: { requestIds: [] } });
    expect(yield* Fiber.join(call)).toEqual({ requestIds: [] });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("refuses an environment the desktop reports offline", () =>
  Effect.gen(function* () {
    const broker = yield* FleetBroker.FleetBroker;
    yield* serve(yield* broker.connect(host("desktop", false)));
    const error = yield* broker.invoke(studio, invoke).pipe(Effect.asVoid, Effect.flip);
    expect(error.message).toContain("offline");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

const mcpInvoke: FleetInvokeInput = {
  mcp: {
    tool: "t3_project_list",
    arguments: {},
    namespace: "caller",
    readOnly: true,
    runtimeMode: "approval-required",
    interactionMode: "plan",
  },
};

it.effect.each([invoke, mcpInvoke])(
  "a newer desktop registration fails calls the old one still owed: %o",
  (input) =>
    Effect.gen(function* () {
      const broker = yield* FleetBroker.FleetBroker;
      const firstRequest = yield* serve(yield* broker.connect(host("old")));
      const call = yield* broker
        .invoke(studio, input)
        .pipe(Effect.asVoid, Effect.flip, Effect.forkScoped);
      yield* Deferred.await(firstRequest);
      yield* serve(yield* broker.connect(host("new")));
      const error = yield* Fiber.join(call);
      expect(error.code).toBe("environment_unavailable");
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("a renderer must offer ordinary MCP relay before it can carry ordinary calls", () =>
  Effect.gen(function* () {
    const broker = yield* FleetBroker.FleetBroker;
    yield* serve(yield* broker.connect(host("coordination-only", true, false)));
    expect(yield* broker.reach).toMatchObject({ hostConnected: true, mcpRelay: false });
    const denied = yield* broker.invoke(studio, mcpInvoke).pipe(Effect.exit);
    expect(Exit.isFailure(denied) && Cause.squash(denied.cause)).toMatchObject({
      code: "environment_unavailable",
    });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("a desktop without the relay never displaces the one carrying it", () =>
  Effect.gen(function* () {
    const broker = yield* FleetBroker.FleetBroker;
    const relayRequest = yield* serve(yield* broker.connect(host("own-desktop")));
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* serve(yield* broker.connect(host("second-desktop", true, false)));
        expect(yield* broker.reach).toMatchObject({ hostConnected: true, mcpRelay: true });
        const call = yield* broker.invoke(studio, mcpInvoke).pipe(Effect.forkScoped);
        const request = yield* Deferred.await(relayRequest);
        yield* broker.respond({ requestId: request.requestId, result: { projects: [] } });
        expect(yield* Fiber.join(call)).toEqual({ projects: [] });
      }),
    );
    // The second desktop disconnecting leaves the relay in place.
    expect(yield* broker.reach).toMatchObject({ hostConnected: true, mcpRelay: true });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("retiring a replaced desktop keeps the newer one", () =>
  Effect.gen(function* () {
    const broker = yield* FleetBroker.FleetBroker;
    const oldScope = yield* Scope.make();
    const oldRequest = yield* serve(yield* broker.connect(host("old"))).pipe(
      Scope.provide(oldScope),
    );
    const newRequest = yield* serve(yield* broker.connect(host("new")));
    yield* Scope.close(oldScope, Exit.void);
    expect(yield* broker.reach).toMatchObject({ hostConnected: true, mcpRelay: true });
    const call = yield* broker.invoke(studio, invoke).pipe(Effect.forkScoped);
    const request = yield* Deferred.await(newRequest);
    expect(yield* Deferred.isDone(oldRequest)).toBe(false);
    yield* broker.respond({ requestId: request.requestId, result: { requestIds: [] } });
    expect(yield* Fiber.join(call)).toEqual({ requestIds: [] });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
