/**
 * Relays Home's calls to other environments through the desktop renderer, the only holder of
 * live connections to them. The newest `fleet.connect` registration wins; with no renderer,
 * Home can act only in its own environment.
 */
import {
  type EnvironmentId,
  type FleetEnvironment,
  type FleetHostRegistration,
  type FleetHostRequest,
  type FleetHostResponse,
  type FleetInvokeInput,
  FleetResults,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

// One compiled decoder per operation; results cross the relay untyped.
const decodeResult = Object.fromEntries(
  Object.entries(FleetResults).map(([op, schema]) => [op, Schema.decodeUnknownEffect(schema)]),
) as {
  readonly [Op in keyof typeof FleetResults]: (
    input: unknown,
  ) => Effect.Effect<unknown, Schema.SchemaError>;
};

/** Long enough for a slow launch on a remote machine; reads finish far sooner. */
const REQUEST_TIMEOUT = Duration.seconds(90);

export interface FleetReach {
  /** Whether a desktop renderer is relaying. */
  readonly hostConnected: boolean;
  readonly environments: ReadonlyArray<FleetEnvironment>;
}

export class FleetBroker extends Context.Service<
  FleetBroker,
  {
    readonly connect: (
      registration: FleetHostRegistration,
    ) => Effect.Effect<Stream.Stream<FleetHostRequest>>;
    readonly respond: (response: FleetHostResponse) => Effect.Effect<void>;
    readonly reach: Effect.Effect<FleetReach>;
    /** Runs one operation in another environment and decodes its result. */
    readonly invoke: (
      environmentId: EnvironmentId,
      invoke: FleetInvokeInput,
    ) => Effect.Effect<unknown, OrchestratorMcpFailure>;
  }
>()("t3/home/FleetBroker") {}

interface Host {
  readonly queue: Queue.Queue<FleetHostRequest, Cause.Done>;
  readonly environments: ReadonlyArray<FleetEnvironment>;
}

interface Pending {
  readonly queue: Host["queue"];
  readonly deferred: Deferred.Deferred<unknown, OrchestratorMcpFailure>;
}

interface State {
  readonly host: Host | null;
  readonly pending: ReadonlyMap<string, Pending>;
}

const unavailable = (message: string) =>
  new OrchestratorMcpFailure({ code: "environment_unavailable", message });

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const state = yield* SynchronizedRef.make<State>({ host: null, pending: new Map() });

  // Ends one host generation and fails what it still owed.
  const retire = (queue: Host["queue"]) =>
    SynchronizedRef.modifyEffect(state, (current) => {
      const owed = [...current.pending].filter(([, entry]) => entry.queue === queue);
      const pending = new Map(current.pending);
      for (const [requestId] of owed) pending.delete(requestId);
      const host = current.host?.queue === queue ? null : current.host;
      return Effect.gen(function* () {
        yield* Queue.shutdown(queue);
        yield* Effect.forEach(
          owed,
          ([, entry]) =>
            Deferred.fail(
              entry.deferred,
              unavailable("The desktop window relaying Home's calls disconnected."),
            ),
          { discard: true },
        );
        return [undefined, { host, pending }] as const;
      });
    });

  const acquire = Effect.fn("FleetBroker.acquire")(function* (registration: FleetHostRegistration) {
    const queue = yield* Queue.unbounded<FleetHostRequest, Cause.Done>();
    const previous = yield* SynchronizedRef.modify(state, (current) => [
      current.host,
      {
        ...current,
        host: { queue, environments: registration.environments },
      },
    ]);
    if (previous !== null) yield* retire(previous.queue);
    return queue;
  });

  return FleetBroker.of({
    connect: Effect.fn("FleetBroker.connect")((registration) =>
      Effect.succeed(
        Stream.unwrap(
          Effect.acquireRelease(acquire(registration), retire).pipe(
            Effect.map((queue) => Stream.fromQueue(queue)),
          ),
        ),
      ),
    ),

    respond: Effect.fn("FleetBroker.respond")(function* (response) {
      const entry = yield* SynchronizedRef.modify(state, (current) => {
        const found = current.pending.get(response.requestId);
        if (found === undefined) return [undefined, current] as const;
        const pending = new Map(current.pending);
        pending.delete(response.requestId);
        return [found, { ...current, pending }] as const;
      });
      if (entry === undefined) return;
      if ("failure" in response) {
        yield* Deferred.fail(entry.deferred, response.failure);
      } else {
        yield* Deferred.succeed(entry.deferred, response.result);
      }
    }),

    reach: SynchronizedRef.get(state).pipe(
      Effect.map(({ host }) => ({
        hostConnected: host !== null,
        environments: host?.environments ?? [],
      })),
    ),

    invoke: Effect.fn("FleetBroker.invoke")(function* (environmentId, invoke) {
      const requestId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const deferred = yield* Deferred.make<unknown, OrchestratorMcpFailure>();
      const offered = yield* SynchronizedRef.modifyEffect(state, (current) => {
        const host = current.host;
        if (host === null) {
          return Effect.succeed([
            Option.some(
              unavailable(
                "No desktop window is relaying Home's calls. Open the T3 Code desktop app.",
              ),
            ),
            current,
          ] as const);
        }
        const environment = host.environments.find(
          (candidate) => candidate.environmentId === environmentId,
        );
        if (environment === undefined || !environment.connected) {
          return Effect.succeed([
            Option.some(
              unavailable(
                environment === undefined
                  ? `Environment ${environmentId} is not connected to this desktop.`
                  : `Environment ${environment.label} is offline.`,
              ),
            ),
            current,
          ] as const);
        }
        const pending = new Map(current.pending);
        pending.set(requestId, { queue: host.queue, deferred });
        return Queue.offer(host.queue, { requestId, environmentId, invoke }).pipe(
          Effect.as([Option.none(), { ...current, pending }] as const),
        );
      });
      if (Option.isSome(offered)) return yield* offered.value;
      const settled = yield* Deferred.await(deferred).pipe(
        Effect.timeoutOption(REQUEST_TIMEOUT),
        Effect.ensuring(
          SynchronizedRef.update(state, (current) => {
            if (!current.pending.has(requestId)) return current;
            const pending = new Map(current.pending);
            pending.delete(requestId);
            return { ...current, pending };
          }),
        ),
      );
      if (Option.isNone(settled)) {
        return yield* unavailable("The other environment did not answer in time.");
      }
      return yield* decodeResult[invoke.request.op](settled.value).pipe(
        Effect.mapError(() =>
          unavailable("The other environment answered in a shape this version cannot read."),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(FleetBroker, make);
