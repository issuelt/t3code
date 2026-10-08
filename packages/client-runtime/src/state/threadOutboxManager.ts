import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/reactivity";

import {
  flattenQueuedThreadMessages,
  groupQueuedThreadMessages,
  type QueuedThreadMessage,
} from "./threadOutboxModel.ts";

export class ThreadOutboxStorageError extends Schema.TaggedError<ThreadOutboxStorageError>()(
  "ThreadOutboxStorageError",
  {
    operation: Schema.Literals(["load", "read-message", "write", "remove"]),
    environmentId: Schema.NullOr(EnvironmentId),
    threadId: Schema.NullOr(ThreadId),
    messageId: Schema.NullOr(MessageId),
    fileName: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread outbox storage operation ${this.operation} failed for environment ${this.environmentId ?? "unknown"}, thread ${this.threadId ?? "unknown"}, message ${this.messageId ?? "unknown"}, file ${this.fileName ?? "unknown"}.`;
  }
}

/** Platform persistence for queued outbox messages (Expo files, localStorage, ...). */
export interface ThreadOutboxStorage {
  readonly load: () => Promise<ReadonlyArray<QueuedThreadMessage>>;
  readonly write: (message: QueuedThreadMessage) => Promise<void>;
  readonly remove: (message: QueuedThreadMessage) => Promise<void>;
}

export class ThreadOutboxManagerError extends Schema.TaggedError<ThreadOutboxManagerError>()(
  "ThreadOutboxManagerError",
  {
    operation: Schema.Literals([
      "load",
      "enqueue",
      "update",
      "remove",
      "clear-environment-load",
      "clear-environment-remove",
    ]),
    environmentId: Schema.NullOr(EnvironmentId),
    threadId: Schema.NullOr(ThreadId),
    messageId: Schema.NullOr(MessageId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread outbox operation ${this.operation} failed for environment ${this.environmentId ?? "unknown"}, thread ${this.threadId ?? "unknown"}, message ${this.messageId ?? "unknown"}.`;
  }
}

export interface ThreadOutboxManagerOptions {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly storage: ThreadOutboxStorage;
  readonly atomLabel?: string;
  /** Non-fatal failure reporting (e.g. console.warn); owned by the platform caller. */
  readonly warn: (message: string, error: unknown) => void;
  /**
   * When true, a `storage.write`/`storage.remove` failure is reported via
   * `warn()` and swallowed instead of rejecting: the in-memory queue is updated
   * first and stays the source of truth for delivery, so persistence is purely
   * a survive-reload nicety. Web opts in because localStorage's ~5MB origin
   * quota is easily blown by a queued message's base64 image `dataUrl`s — a
   * quota `setItem` throw must never hard-fail a send/steer. Mobile leaves this
   * off so its durable Expo file storage keeps strict write/remove consistency.
   */
  readonly bestEffortPersistence?: boolean;
}

export function createThreadOutboxManager(options: ThreadOutboxManagerOptions) {
  const queuedMessagesByThreadKeyAtom = Atom.make<
    Record<string, ReadonlyArray<QueuedThreadMessage>>
  >({}).pipe(Atom.keepAlive, Atom.withLabel(options.atomLabel ?? "thread-outbox:queued-messages"));
  const warn = options.warn;
  const bestEffortPersistence = options.bestEffortPersistence ?? false;
  let loadPromise: Promise<void> | null = null;
  let mutationQueue: Promise<void> = Promise.resolve();

  const serialize = <A>(mutation: () => Promise<A>): Promise<A> => {
    const result = mutationQueue.then(mutation, mutation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const currentMessages = (): ReadonlyArray<QueuedThreadMessage> =>
    flattenQueuedThreadMessages(options.registry.get(queuedMessagesByThreadKeyAtom));

  const setMessages = (messages: ReadonlyArray<QueuedThreadMessage>): void => {
    options.registry.set(queuedMessagesByThreadKeyAtom, groupQueuedThreadMessages(messages));
  };

  // Runs a persistence side effect (write/remove). In best-effort mode a
  // failure is warned and swallowed so the in-memory queue — already updated by
  // the caller — still drives delivery; in strict mode it rejects with the
  // structured manager error, preserving durable-storage consistency.
  const persist = async (
    operation: "enqueue" | "update" | "remove",
    message: QueuedThreadMessage,
    run: () => Promise<void>,
  ): Promise<void> => {
    try {
      await run();
    } catch (cause) {
      const error = new ThreadOutboxManagerError({
        operation,
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        cause,
      });
      if (bestEffortPersistence) {
        warn(`[thread-outbox] failed to persist ${operation}; keeping message in memory`, error);
        return;
      }
      throw error;
    }
  };

  const load = (): Promise<void> => {
    if (loadPromise !== null) {
      return loadPromise;
    }
    loadPromise = serialize(async () => {
      const persistedMessages = await options.storage.load();
      setMessages([...persistedMessages, ...currentMessages()]);
    }).catch((cause) => {
      loadPromise = null;
      warn(
        "[thread-outbox] failed to load persisted messages",
        new ThreadOutboxManagerError({
          operation: "load",
          environmentId: null,
          threadId: null,
          messageId: null,
          cause,
        }),
      );
    });
    return loadPromise;
  };

  const enqueue = (message: QueuedThreadMessage): Promise<void> =>
    serialize(async () => {
      // Dedup by messageId so a retry/re-enqueue never doubles the row (upstream parity).
      const applyToMemory = (): void =>
        setMessages([
          ...currentMessages().filter((candidate) => candidate.messageId !== message.messageId),
          message,
        ]);
      // Best-effort: enqueue in memory first so a persistence hiccup can never
      // lose the send. Strict: only enqueue once the durable write succeeds.
      if (bestEffortPersistence) {
        applyToMemory();
      }
      await persist("enqueue", message, () => options.storage.write(message));
      if (!bestEffortPersistence) {
        applyToMemory();
      }
    });

  // Rewrites an already-queued message. A no-op when the message has been
  // removed in the meantime (e.g. deleted or delivered), so a trailing editor
  // flush can never resurrect it. Returns whether the message was updated.
  const update = (message: QueuedThreadMessage): Promise<boolean> =>
    serialize(async () => {
      const exists = currentMessages().some(
        (candidate) => candidate.messageId === message.messageId,
      );
      if (!exists) {
        return false;
      }
      const applyToMemory = (): void =>
        setMessages([
          ...currentMessages().filter((candidate) => candidate.messageId !== message.messageId),
          message,
        ]);
      if (bestEffortPersistence) {
        applyToMemory();
      }
      await persist("update", message, () => options.storage.write(message));
      if (!bestEffortPersistence) {
        applyToMemory();
      }
      return true;
    });

  const remove = (message: QueuedThreadMessage): Promise<void> =>
    serialize(async () => {
      const applyToMemory = (): void =>
        setMessages(
          currentMessages().filter((candidate) => candidate.messageId !== message.messageId),
        );
      if (bestEffortPersistence) {
        applyToMemory();
      }
      await persist("remove", message, () => options.storage.remove(message));
      if (!bestEffortPersistence) {
        applyToMemory();
      }
    });

  const clearEnvironment = (environmentId: EnvironmentId): Promise<void> =>
    serialize(async () => {
      const persisted = await options.storage.load().catch((cause) => {
        warn(
          "[thread-outbox] failed to load messages while clearing environment",
          new ThreadOutboxManagerError({
            operation: "clear-environment-load",
            environmentId,
            threadId: null,
            messageId: null,
            cause,
          }),
        );
        return [];
      });
      const allMessages = flattenQueuedThreadMessages(
        groupQueuedThreadMessages([...persisted, ...currentMessages()]),
      );
      const removedMessageIds = new Set<MessageId>();

      await Promise.all(
        allMessages
          .filter((message) => message.environmentId === environmentId)
          .map(async (message) => {
            try {
              await options.storage.remove(message);
              removedMessageIds.add(message.messageId);
            } catch (cause) {
              warn(
                "[thread-outbox] failed to clear persisted message",
                new ThreadOutboxManagerError({
                  operation: "clear-environment-remove",
                  environmentId: message.environmentId,
                  threadId: message.threadId,
                  messageId: message.messageId,
                  cause,
                }),
              );
            }
          }),
      );

      setMessages(allMessages.filter((message) => !removedMessageIds.has(message.messageId)));
    });

  return {
    queuedMessagesByThreadKeyAtom,
    serialize,
    load,
    enqueue,
    update,
    remove,
    clearEnvironment,
  };
}
