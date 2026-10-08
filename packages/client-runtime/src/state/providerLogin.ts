import { WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import {
  applyProviderLoginStreamEvent,
  EMPTY_PROVIDER_LOGIN_STATE,
} from "./providerLoginSession.ts";

export function createProviderLoginEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const resizeScheduler = createAtomCommandScheduler();
  const instanceKey = ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly instanceId: string };
  }) => JSON.stringify([environmentId, input.instanceId]);
  return {
    attach: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:provider-login:attach",
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.providerLoginStart>) =>
        subscribe(WS_METHODS.providerLoginStart, input).pipe(
          Stream.scan(() => EMPTY_PROVIDER_LOGIN_STATE, applyProviderLoginStreamEvent),
        ),
    }),
    write: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-login:write",
      tag: WS_METHODS.providerLoginWrite,
    }),
    resize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-login:resize",
      tag: WS_METHODS.providerLoginResize,
      scheduler: resizeScheduler,
      concurrency: { mode: "latest", key: instanceKey },
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-login:cancel",
      tag: WS_METHODS.providerLoginCancel,
    }),
  };
}

export * from "./providerLoginSession.ts";
