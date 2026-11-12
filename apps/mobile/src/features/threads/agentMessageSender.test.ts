import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { agentMessageSender } from "./agentMessageSender";

const here = EnvironmentId.make("environment-here");
const there = EnvironmentId.make("environment-there");

describe("agentMessageSender", () => {
  it("names a linked environment's sender, which has no local sender thread", () => {
    expect(
      agentMessageSender(
        { linkedSender: { environmentId: there, threadId: ThreadId.make("lead"), title: "Lead" } },
        here,
      ),
    ).toEqual({ environmentId: there, threadId: ThreadId.make("lead"), linked: true });
  });

  it("falls back to the local sender, then the coordination requester", () => {
    expect(agentMessageSender({ senderThreadId: ThreadId.make("worker") }, here)).toEqual({
      environmentId: here,
      threadId: ThreadId.make("worker"),
      linked: false,
    });
    expect(
      agentMessageSender(
        {
          coordination: {
            kind: "request",
            requester: { environmentId: here, threadId: ThreadId.make("home") },
          },
        },
        here,
      ),
    ).toEqual({ environmentId: here, threadId: ThreadId.make("home"), linked: false });
    expect(agentMessageSender({}, here)).toBeNull();
  });
});
