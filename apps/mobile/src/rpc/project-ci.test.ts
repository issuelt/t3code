import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { limitCiReads } from "./project-ci";

it.effect("bounds overlapping CI reads when project, remote or refresh changes", () =>
  Effect.gen(function* () {
    const full = yield* Deferred.make<void>();
    const response = yield* Deferred.make<void>();
    let active = 0;
    let maximum = 0;
    const reads = yield* Effect.forkChild(
      Effect.forEach(
        ["discovery", "upstream", "origin", "gitlab", "new-project", "refresh"],
        () =>
          limitCiReads(
            Effect.gen(function* () {
              active++;
              maximum = Math.max(maximum, active);
              if (active === 2) yield* Deferred.succeed(full, undefined);
              yield* Deferred.await(response);
              active--;
              return "answered";
            }),
          ),
        { concurrency: "unbounded" },
      ),
    );
    yield* Deferred.await(full);
    expect(active).toBe(2);
    yield* Deferred.succeed(response, undefined);
    expect(yield* Fiber.join(reads)).toEqual(Array(6).fill("answered"));
    expect(maximum).toBe(2);
    expect(active).toBe(0);
  }),
);
