import type { EnvironmentId, ProjectCiRunInput, ProjectCiRunResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import type { CiRun } from "./projectCiModel";

export type CiRunTarget = {
  readonly environmentId: EnvironmentId;
  readonly input: ProjectCiRunInput;
};

export function createCiRunDetailsView<E>(
  query: (target: CiRunTarget) => Atom.Atom<AsyncResult.AsyncResult<ProjectCiRunResult, E>>,
) {
  return Atom.family(
    ({ target, fallback }: { readonly target: CiRunTarget; readonly fallback: CiRun }) =>
      Atom.make((get) => {
        const result = get(query(target));
        const current = Option.getOrNull(AsyncResult.value(result));
        const previous = Option.getOrNull(
          get.self<{ readonly value: ProjectCiRunResult | null }>(),
        )?.value;
        const value =
          current?.run.jobsError && previous
            ? {
                ...current,
                run: {
                  ...current.run,
                  jobs: [
                    ...new Map(
                      [...previous.run.jobs, ...current.run.jobs].map((job) => [job.url, job]),
                    ).values(),
                  ],
                },
              }
            : current;
        const error = AsyncResult.isFailure(result) ? Cause.squash(result.cause) : null;
        return {
          run: value?.run ?? fallback,
          value,
          error:
            error === null
              ? null
              : error instanceof Error
                ? error.message
                : "Could not read CI run.",
          waiting: result.waiting || result._tag === "Initial",
        };
      }),
  );
}
