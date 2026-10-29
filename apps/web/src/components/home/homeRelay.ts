import {
  type EnvironmentId,
  type FleetHostRequest,
  type FleetHostResponse,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";

export async function relayFleetRequest(input: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly homeEnvironmentId: EnvironmentId;
  readonly request: FleetHostRequest;
  readonly forward: () => Promise<FleetHostResponse>;
}): Promise<FleetHostResponse> {
  if (
    input.sourceEnvironmentId !== input.homeEnvironmentId &&
    (input.request.invoke.request.op !== "threads.deliver-result" ||
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
