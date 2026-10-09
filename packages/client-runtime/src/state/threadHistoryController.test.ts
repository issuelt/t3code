import { MessageId, TurnItemId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { RpcSession } from "../rpc/session.ts";
import { v2Now, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import * as ThreadHistoryController from "./threadHistoryController.ts";
import { makeEnvironmentThreadState } from "./threads.ts";
import * as ThreadSnapshotLoader from "./threadSnapshotHttp.ts";

const ENV = "env-history" as EnvironmentId;
const THREAD = "thread-history" as ThreadId;

function handler(
  tag: string,
): ThreadHistoryController.ThreadHistoryHandler & { readonly tag: string; readonly calls: number } {
  const state = { tag, calls: 0 };
  return {
    get tag() {
      return state.tag;
    },
    get calls() {
      return state.calls;
    },
    loadEarlier: () => {
      state.calls += 1;
      return Effect.succeed({
        _tag: "loaded",
      } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult);
    },
  };
}

describe("ThreadHistoryController", () => {
  it.effect("keeps 40 search turns in order after activity fails and a normal 20-turn retry", () =>
    Effect.gen(function* () {
      const controller = yield* ThreadHistoryController.ThreadHistoryController;
      const target = new PrimaryConnectionTarget({
        environmentId: ENV,
        label: "History test",
        httpBaseUrl: "https://history.example.test",
        wsBaseUrl: "wss://history.example.test",
      });
      const message = (index: number) => ({
        id: TurnItemId.make(`message-item-${index}`),
        type: "assistant_message" as const,
        threadId: v2ThreadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: index * 2 + 1,
        status: "completed" as const,
        title: null,
        messageId: MessageId.make(`message-${index}`),
        text: `Message ${index}`,
        streaming: false,
        startedAt: v2Now,
        completedAt: v2Now,
        updatedAt: v2Now,
      });
      const activity = (index: number) => ({
        ...message(index),
        id: TurnItemId.make(`activity-${index}`),
        type: "command_execution" as const,
        ordinal: index * 2 + 2,
        input: "pwd",
        output: "",
        exitCode: 0,
      });
      const projected = (item: ReturnType<typeof message> | ReturnType<typeof activity>) => ({
        position: 0,
        visibility: "local" as const,
        sourceThreadId: v2ThreadId,
        sourceItemId: item.id,
        item,
      });
      const cold = projected(message(40));
      const projection = { ...v2Projection, turnItems: [cold.item], visibleTurnItems: [cold] };
      const state = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const session = yield* SubscriptionRef.make(Option.none<RpcSession>());
      const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
        Option.some({
          environmentId: ENV,
          label: target.label,
          httpBaseUrl: target.httpBaseUrl,
          socketUrl: target.wsBaseUrl,
          httpAuthorization: null,
          target,
        }),
      );
      const requests: Array<{ view: string | null; through: string | null }> = [];
      const threadState = yield* makeEnvironmentThreadState(v2ThreadId).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, {
          target,
          state,
          session,
          prepared,
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        }),
        Effect.provideService(ThreadSnapshotLoader.ThreadSnapshotLoader, {
          load: () => Effect.succeed({ _tag: "unavailable" }),
        }),
        Effect.provideService(Persistence.EnvironmentCacheStore, {
          loadThread: () =>
            Effect.succeedSome({
              snapshotSequence: 14,
              projection,
              historyCursor: "search-cursor",
              hasMoreHistory: true,
            }),
          saveThread: () => Effect.void,
          removeThread: () => Effect.void,
          loadShell: () => Effect.succeedNone,
          saveShell: () => Effect.void,
          loadServerConfig: () => Effect.succeedNone,
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeedNone,
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: () => Effect.void,
          clearVcsRefs: () => Effect.void,
          clear: () => Effect.void,
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request, url) => {
            expect(url.searchParams.get("cursor")).toBe("search-cursor");
            const view = url.searchParams.get("view");
            const through = url.searchParams.get("throughEntryId");
            requests.push({ view, through });
            if (view === null && through !== null) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response("Activity unavailable", { status: 503 }),
                ),
              );
            }
            const items =
              view === "conversation"
                ? Array.from({ length: 40 }, (_, index) => projected(message(index)))
                : Array.from({ length: 20 }, (_, index) => [
                    projected(message(index + 20)),
                    projected(activity(index + 20)),
                  ]).flat();
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  snapshotSequence: 14,
                  items,
                  nextCursor: "older-cursor",
                  hasMoreHistory: true,
                }),
              ),
            );
          }),
        ),
      );
      expect(yield* controller.loadEarlier(ENV, v2ThreadId, "message-0")).toMatchObject({
        _tag: "error",
      });
      const failed = yield* SubscriptionRef.get(threadState);
      expect(failed.history).toMatchObject({
        historyCursor: "search-cursor",
        loading: false,
        expanded: true,
      });
      expect(failed.history.error).not.toBeNull();
      expect(
        Option.getOrThrow(failed.data).visibleTurnItems.map((row) => row.sourceItemId),
      ).toEqual(Array.from({ length: 41 }, (_, index) => `message-item-${index}`));
      expect(yield* controller.loadEarlier(ENV, v2ThreadId)).toEqual({ _tag: "loaded" });
      const retried = yield* SubscriptionRef.get(threadState);
      expect(
        Option.getOrThrow(retried.data).visibleTurnItems.map((row) => row.sourceItemId),
      ).toEqual([
        ...Array.from({ length: 20 }, (_, index) => `message-item-${index}`),
        ...Array.from({ length: 20 }, (_, index) => [
          `message-item-${index + 20}`,
          `activity-${index + 20}`,
        ]).flat(),
        "message-item-40",
      ]);
      expect(retried.history).toMatchObject({
        historyCursor: "older-cursor",
        loading: false,
        error: null,
      });
      expect(requests).toEqual([
        { view: "conversation", through: "message-0" },
        { view: null, through: "message-0" },
        { view: null, through: null },
      ]);
    }).pipe(Effect.provide(Layer.fresh(ThreadHistoryController.layer))),
  );

  it.effect("does not let an older finalizer delete a newer registration", () =>
    Effect.gen(function* () {
      const controller = yield* ThreadHistoryController.ThreadHistoryController;
      const older = handler("older");
      const newer = handler("newer");

      const olderRegistration = yield* controller.register(ENV, THREAD, older);
      const newerRegistration = yield* controller.register(ENV, THREAD, newer);

      // Older fiber finalizes after the newer handler is already registered.
      yield* controller.unregister(olderRegistration);

      const result = yield* controller.loadEarlier(ENV, THREAD);
      expect(result).toEqual({ _tag: "loaded" });
      expect(newer.calls).toBe(1);
      expect(older.calls).toBe(0);

      yield* controller.unregister(newerRegistration);
      expect(yield* controller.loadEarlier(ENV, THREAD)).toEqual({ _tag: "noop" });
    }).pipe(Effect.provide(ThreadHistoryController.layer)),
  );

  it.effect("unregister removes only its own matching registration", () =>
    Effect.gen(function* () {
      const controller = yield* ThreadHistoryController.ThreadHistoryController;
      const first = handler("first");
      const registration = yield* controller.register(ENV, THREAD, first);
      yield* controller.unregister(registration);
      expect(yield* controller.loadEarlier(ENV, THREAD)).toEqual({ _tag: "noop" });
    }).pipe(Effect.provide(Layer.fresh(ThreadHistoryController.layer))),
  );
});
