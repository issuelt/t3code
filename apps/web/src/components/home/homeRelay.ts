import {
  EnvironmentAuthorizationError,
  type EnvironmentId,
  type FleetHostRequest,
  type FleetHostResponse,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export async function relayFleetRequest(input: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly homeEnvironmentId: EnvironmentId;
  readonly request: FleetHostRequest;
  readonly forward: () => Promise<FleetHostResponse>;
}): Promise<FleetHostResponse> {
  if (
    input.sourceEnvironmentId !== input.homeEnvironmentId &&
    (!("request" in input.request.invoke) ||
      input.request.invoke.request.op !== "threads.deliver-result" ||
      input.request.invoke.actor.environmentId !== input.sourceEnvironmentId)
  ) {
    return {
      requestId: input.request.requestId,
      failure: new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "This environment may only return its coordination results.",
      }),
    };
  }
  return input.forward();
}

const isRelayFailure = Schema.is(OrchestratorMcpFailure);
const isScopeDenial = Schema.is(EnvironmentAuthorizationError);

/**
 * Turns a failed forward into the failure the calling agent sees. A missing scope
 * is a permission denial, so agents do not try to repair a healthy connection.
 */
export const relayFailure = (error: unknown) =>
  isRelayFailure(error)
    ? error
    : isScopeDenial(error)
      ? new OrchestratorMcpFailure({ code: "capability_denied", message: error.message })
      : new OrchestratorMcpFailure({
          code: "environment_unavailable",
          message:
            error instanceof Error ? error.message : "The other environment could not be reached.",
        });
