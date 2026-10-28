import { request } from "@t3tools/client-runtime/rpc";
import { WS_METHODS, type ProjectCiInput, type ProjectCiRunInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

export const limitCiReads = Semaphore.makeUnsafe(2).withPermits(1);

export const readProjectCi = Effect.fn("MobileProjectCi.read")((input: ProjectCiInput) =>
  limitCiReads(request(WS_METHODS.projectCiRead, input)),
);

export const readProjectCiRun = Effect.fn("MobileProjectCi.readRun")((input: ProjectCiRunInput) =>
  limitCiReads(request(WS_METHODS.projectCiReadRun, input)),
);
