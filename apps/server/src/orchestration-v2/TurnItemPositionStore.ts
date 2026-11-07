import { OrchestrationV2TurnItem, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class TurnItemPositionStoreError extends Schema.TaggedError<TurnItemPositionStoreError>()(
  "TurnItemPositionStoreError",
  {
    threadId: ThreadId,
    turnItemId: TurnItemId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isTurnItemPositionStoreError = Schema.is(TurnItemPositionStoreError);

export interface TurnItemPositionStoreV2Shape {
  readonly allocate: (input: {
    readonly threadId: ThreadId;
    readonly turnItemId: TurnItemId;
    readonly runId: RunId | null;
    readonly runOrdinal?: number;
  }) => Effect.Effect<number, TurnItemPositionStoreError>;
  readonly normalize: (
    item: OrchestrationV2TurnItem,
    runOrdinal?: number,
  ) => Effect.Effect<OrchestrationV2TurnItem, TurnItemPositionStoreError>;
}

export class TurnItemPositionStoreV2 extends Context.Service<
  TurnItemPositionStoreV2,
  TurnItemPositionStoreV2Shape
>()("t3/orchestration-v2/TurnItemPositionStore/TurnItemPositionStoreV2") {}

export const layer: Layer.Layer<TurnItemPositionStoreV2, never, SqlClient.SqlClient> = Layer.effect(
  TurnItemPositionStoreV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const storedOrdinal = (threadId: ThreadId, turnItemId: TurnItemId) =>
      sql<{ readonly ordinal: number }>`
        SELECT ordinal
        FROM orchestration_v2_turn_item_positions
        WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
        LIMIT 1
      `.pipe(Effect.map((rows) => rows[0]?.ordinal));

    const runOrdinalOf = (threadId: ThreadId, runId: RunId) =>
      sql<{ readonly ordinal: number }>`
        SELECT ordinal FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} AND run_id = ${runId}
        LIMIT 1
      `.pipe(Effect.map((rows) => rows[0]?.ordinal));

    const toPositionError =
      (threadId: ThreadId, turnItemId: TurnItemId) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isTurnItemPositionStoreError(cause)
              ? cause
              : new TurnItemPositionStoreError({ threadId, turnItemId, cause }),
          ),
        );

    const insertPosition = Effect.fnUntraced(function* (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: TurnItemId;
      readonly runId: RunId | null;
      readonly runOrdinal?: number;
    }) {
      const { threadId, turnItemId, runId } = input;
      const runOrdinal =
        input.runOrdinal ?? (runId === null ? undefined : yield* runOrdinalOf(threadId, runId));
      const lowerBound = runOrdinal === undefined ? 0 : runOrdinal * 1_000_000;
      const upperBound = runOrdinal === undefined ? 999_999 : lowerBound + 999_999;
      yield* sql`
        INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
        SELECT
          ${threadId},
          ${turnItemId},
          COALESCE(MAX(ordinal), ${lowerBound}) + 1
        FROM orchestration_v2_turn_item_positions
        WHERE thread_id = ${threadId}
          AND ordinal >= ${lowerBound}
          AND ordinal <= ${upperBound}
        ON CONFLICT(thread_id, turn_item_id) DO NOTHING
      `;
      const ordinal = yield* storedOrdinal(threadId, turnItemId);
      if (ordinal === undefined) {
        return yield* new TurnItemPositionStoreError({
          threadId,
          turnItemId,
          cause: "Position allocation returned no row.",
        });
      }
      return ordinal;
    });

    const allocate: TurnItemPositionStoreV2Shape["allocate"] =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(
        function* (input) {
          return (
            (yield* storedOrdinal(input.threadId, input.turnItemId)) ??
            (yield* insertPosition(input))
          );
        },
        (effect, { threadId, turnItemId }) => toPositionError(threadId, turnItemId)(effect),
      );

    return TurnItemPositionStoreV2.of({
      allocate,
      // Per-event normalization shares the enclosing orchestration span.
      normalize: Effect.fnUntraced(
        function* (item, runOrdinal) {
          const withOrdinal = (ordinal: number) =>
            item.ordinal === ordinal ? item : { ...item, ordinal };
          const stored = yield* storedOrdinal(item.threadId, item.id);
          if (stored === undefined) {
            return withOrdinal(
              yield* insertPosition({
                threadId: item.threadId,
                turnItemId: item.id,
                runId: item.runId,
                ...(runOrdinal === undefined ? {} : { runOrdinal }),
              }),
            );
          }
          if (
            item.type !== "user_message" ||
            (item.inputIntent !== "queued_turn" &&
              item.inputIntent !== "promoted_queued_to_steer") ||
            item.status !== "completed" ||
            item.runId === null
          ) {
            return withOrdinal(stored);
          }
          const deliveredRunOrdinal =
            runOrdinal ?? (yield* runOrdinalOf(item.threadId, item.runId));
          if (deliveredRunOrdinal === undefined) return withOrdinal(stored);
          const lowerBound = deliveredRunOrdinal * 1_000_000;
          const upperBound = lowerBound + 999_999;
          if (stored >= lowerBound && stored <= upperBound) return withOrdinal(stored);
          // Delivery can move a pending prompt to a later run or steer it into an earlier one.
          yield* sql`
            UPDATE orchestration_v2_turn_item_positions
            SET ordinal = (
              SELECT COALESCE(MAX(ordinal), ${lowerBound}) + 1
              FROM orchestration_v2_turn_item_positions
              WHERE thread_id = ${item.threadId}
                AND ordinal >= ${lowerBound}
                AND ordinal <= ${upperBound}
            )
            WHERE thread_id = ${item.threadId} AND turn_item_id = ${item.id}
          `;
          return withOrdinal((yield* storedOrdinal(item.threadId, item.id)) ?? stored);
        },
        (effect, item) => toPositionError(item.threadId, item.id)(effect),
      ),
    });
  }),
);
