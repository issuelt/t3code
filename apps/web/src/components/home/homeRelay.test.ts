import { EnvironmentId, MessageId, ThreadId, type FleetHostRequest } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { relayFleetRequest } from "./homeRelay";

const home = EnvironmentId.make("home");
const remote = EnvironmentId.make("remote");
const request = (op: "threads.launch" | "threads.deliver-result"): FleetHostRequest => ({
  requestId: "return",
  environmentId: home,
  invoke: {
    actor: { environmentId: remote, threadId: ThreadId.make("worker") },
    request:
      op === "threads.launch"
        ? { op, input: { scratch: true, title: "Unexpected job" } }
        : {
            op,
            input: {
              threadId: ThreadId.make("pm"),
              requestMessageId: MessageId.make("original"),
              text: "Done",
            },
          },
  },
});

it("refuses foreign launches before invoking with desktop credentials", async () => {
  const forward = vi.fn(async () => ({ requestId: "return", result: {} }));
  const result = await relayFleetRequest({
    sourceEnvironmentId: remote,
    homeEnvironmentId: home,
    request: request("threads.launch"),
    forward,
  });
  expect(result).toMatchObject({ failure: { code: "capability_denied" } });
  expect(forward).not.toHaveBeenCalled();
});

it("only forwards a remote result whose actor belongs to its source environment", async () => {
  const forward = vi.fn(async () => ({ requestId: "return", result: { delivered: true } }));
  const valid = request("threads.deliver-result");
  await relayFleetRequest({
    sourceEnvironmentId: remote,
    homeEnvironmentId: home,
    request: valid,
    forward,
  });
  const invalid = {
    ...valid,
    invoke: { ...valid.invoke, actor: { ...valid.invoke.actor, environmentId: home } },
  };
  const result = await relayFleetRequest({
    sourceEnvironmentId: remote,
    homeEnvironmentId: home,
    request: invalid,
    forward,
  });
  expect(result).toMatchObject({ failure: { code: "capability_denied" } });
  expect(forward).toHaveBeenCalledTimes(1);
});

it("preserves Home's intentional fleet operations", async () => {
  const forward = vi.fn(async () => ({ requestId: "return", result: {} }));
  await relayFleetRequest({
    sourceEnvironmentId: home,
    homeEnvironmentId: home,
    request: request("threads.launch"),
    forward,
  });
  expect(forward).toHaveBeenCalledTimes(1);
});
