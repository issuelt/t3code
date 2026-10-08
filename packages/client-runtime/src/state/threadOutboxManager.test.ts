import { describe, expect, it } from "@effect/vitest";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";

import {
  createThreadOutboxManager,
  ThreadOutboxManagerError,
  type ThreadOutboxStorage,
} from "./threadOutboxManager.ts";
import type { QueuedThreadMessage } from "./threadOutboxModel.ts";

function queuedMessage(input: {
  readonly messageId: string;
  readonly createdAt: string;
}): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make(input.messageId),
    commandId: CommandId.make(`command-${input.messageId}`),
    text: input.messageId,
    attachments: [],
    createdAt: input.createdAt,
  };
}

describe("threadOutboxManager best-effort persistence", () => {
  it("keeps a queued message in memory when the write fails, without rejecting", async () => {
    const registry = AtomRegistry.make();
    const writeCause = new Error("QuotaExceededError");
    const warnings: Array<{ message: string; error: unknown }> = [];
    const storage: ThreadOutboxStorage = {
      load: async () => [],
      write: async () => {
        throw writeCause;
      },
      remove: async () => undefined,
    };
    const manager = createThreadOutboxManager({
      registry,
      storage,
      bestEffortPersistence: true,
      warn: (message, error) => warnings.push({ message, error }),
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-07-06T10:00:01.000Z",
    });

    // The send must resolve — a persistence hiccup can never fail steering.
    await expect(manager.enqueue(message)).resolves.toBeUndefined();
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });
    expect(warnings).toEqual([
      {
        message: "[thread-outbox] failed to persist enqueue; keeping message in memory",
        error: new ThreadOutboxManagerError({
          operation: "enqueue",
          environmentId: message.environmentId,
          threadId: message.threadId,
          messageId: message.messageId,
          cause: writeCause,
        }),
      },
    ]);
    registry.dispose();
  });

  it("drops the queued message from memory even when the durable remove fails", async () => {
    const registry = AtomRegistry.make();
    const removeCause = new Error("remove failed");
    const warnings: Array<{ message: string; error: unknown }> = [];
    const storage: ThreadOutboxStorage = {
      load: async () => [],
      write: async () => undefined,
      remove: async () => {
        throw removeCause;
      },
    };
    const manager = createThreadOutboxManager({
      registry,
      storage,
      bestEffortPersistence: true,
      warn: (message, error) => warnings.push({ message, error }),
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-07-06T10:00:01.000Z",
    });

    await manager.enqueue(message);
    await expect(manager.remove(message)).resolves.toBeUndefined();
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    expect(warnings.map((warning) => warning.message)).toContain(
      "[thread-outbox] failed to persist remove; keeping message in memory",
    );
    registry.dispose();
  });

  it("still rejects and keeps memory unchanged in strict mode (mobile behavior)", async () => {
    const registry = AtomRegistry.make();
    const writeCause = new Error("disk full");
    const storage: ThreadOutboxStorage = {
      load: async () => [],
      write: async () => {
        throw writeCause;
      },
      remove: async () => undefined,
    };
    const manager = createThreadOutboxManager({ registry, storage, warn: () => {} });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-07-06T10:00:01.000Z",
    });

    await expect(manager.enqueue(message)).rejects.toEqual(
      new ThreadOutboxManagerError({
        operation: "enqueue",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        cause: writeCause,
      }),
    );
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });
});
