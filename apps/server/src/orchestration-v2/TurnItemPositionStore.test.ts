import { assert, it } from "@effect/vitest";
import { type OrchestrationV2TurnItem, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const layerTest = TurnItemPositionStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect("reuses an item's position without attempting another allocation insert", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const input = {
      threadId: ThreadId.make("thread:position-reuse"),
      turnItemId: TurnItemId.make("item:streaming"),
      runId: null,
    };
    const first = yield* positions.allocate(input);
    assert.equal(first, 1);

    // BEFORE INSERT runs even when ON CONFLICT would discard the allocation.
    yield* sql`
      CREATE TEMP TRIGGER reject_redundant_position_insert
      BEFORE INSERT ON orchestration_v2_turn_item_positions
      WHEN EXISTS (
        SELECT 1 FROM orchestration_v2_turn_item_positions
        WHERE thread_id = NEW.thread_id AND turn_item_id = NEW.turn_item_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Existing item positions must be reused');
      END
    `;

    const next = yield* positions.allocate({
      ...input,
      turnItemId: TurnItemId.make("item:next"),
    });
    assert.equal(next, first + 1);
    assert.equal(yield* positions.allocate(input), first);
    assert.equal(
      yield* positions.allocate({
        ...input,
        runId: RunId.make("run:moved"),
        runOrdinal: 2,
      }),
      first,
    );
    assert.equal(
      yield* positions.allocate({ ...input, threadId: ThreadId.make("thread:other") }),
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("moves a delivered queued message only when its position is outside the run", () =>
  Effect.gen(function* () {
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const pending = {
      type: "user_message",
      id: TurnItemId.make("item:queued"),
      threadId: ThreadId.make("thread:queued-delivery"),
      runId: RunId.make("run:queued"),
      inputIntent: "queued_turn",
      status: "pending",
      ordinal: 0,
    } as unknown as Extract<OrchestrationV2TurnItem, { type: "user_message" }>;
    assert.equal((yield* positions.normalize(pending, 2)).ordinal, 2_000_001);

    const updates: Array<string> = [];
    const countUpdates: Statement.Transformer = (statement) => {
      const [text] = statement.compile();
      if (/^\s*UPDATE/i.test(text)) updates.push(text);
      return Effect.succeed(statement);
    };
    const completed = { ...pending, status: "completed" as const };
    const inPlace = yield* positions
      .normalize(completed, 2)
      .pipe(Effect.provideService(Statement.CurrentTransformer, countUpdates));
    assert.equal(inPlace.ordinal, 2_000_001);
    assert.deepEqual(updates, []);

    const steered = yield* positions
      .normalize({ ...completed, inputIntent: "promoted_queued_to_steer" }, 3)
      .pipe(Effect.provideService(Statement.CurrentTransformer, countUpdates));
    assert.equal(steered.ordinal, 3_000_001);
    assert.equal(updates.length, 1);
  }).pipe(Effect.provide(layerTest)),
);
