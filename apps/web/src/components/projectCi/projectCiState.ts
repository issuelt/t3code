import type {
  EnvironmentId,
  ProjectCiInput,
  ProjectCiResult,
  ProjectCiRunInput,
  ProjectCiRunResult,
} from "@t3tools/contracts";
import * as Semaphore from "effect/Semaphore";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { formatEnvironmentQueryError } from "~/state/query";

export const limitProjectCiReads = Semaphore.makeUnsafe(4).withPermits(1);

export type Target = { readonly environmentId: EnvironmentId; readonly input: ProjectCiInput };

export function createProjectCiRows<E>(
  query: (target: Target) => Atom.Atom<AsyncResult.AsyncResult<ProjectCiResult, E>>,
) {
  return Atom.family((targets: readonly Target[]) =>
    Atom.make((get) =>
      targets.map((target) => {
        const discoveryTarget = {
          environmentId: target.environmentId,
          input: { projectId: target.input.projectId },
        };
        const discoveryResult = get(query(discoveryTarget));
        const discovery = Option.getOrNull(AsyncResult.value(discoveryResult));
        const remoteName =
          target.input.remoteName ||
          discovery?.remotes.toSorted((a, b) => {
            const rank = (name: string) => (name === "upstream" ? 0 : name === "origin" ? 1 : 2);
            return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
          })[0]?.name;
        const selectedRemote =
          discovery?.remotes.find((remote) => remote.name === remoteName) ?? null;
        const runTarget = remoteName ? { ...target, input: { ...target.input, remoteName } } : null;
        const result = runTarget ? get(query(runTarget)) : null;
        const failure =
          result?._tag === "Failure"
            ? result
            : discoveryResult._tag === "Failure"
              ? discoveryResult
              : null;
        return {
          target,
          discoveryTarget,
          runTarget,
          discovery,
          selectedRemote,
          data: result ? Option.getOrNull(AsyncResult.value(result)) : null,
          error: failure ? formatEnvironmentQueryError(failure.cause) : null,
          pending:
            discoveryResult.waiting ||
            discoveryResult._tag === "Initial" ||
            (result !== null && (result.waiting || result._tag === "Initial")),
        };
      }),
    ),
  );
}

export type RunTarget = {
  readonly environmentId: EnvironmentId;
  readonly input: ProjectCiRunInput;
};

export function createProjectCiRunView<E>(
  query: (target: RunTarget) => Atom.Atom<AsyncResult.AsyncResult<ProjectCiRunResult, E>>,
) {
  return Atom.family((target: RunTarget | null) =>
    Atom.make((get) => {
      const result = target ? get(query(target)) : AsyncResult.initial<ProjectCiRunResult, E>();
      const current = Option.getOrNull(AsyncResult.value(result));
      const previous = Option.getOrNull(
        get.self<{ readonly data: ProjectCiRunResult | null }>(),
      )?.data;
      const data =
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
      return {
        data,
        error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
        pending: target !== null && (result.waiting || result._tag === "Initial"),
      };
    }),
  );
}
