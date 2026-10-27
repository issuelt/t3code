/**
 * One login session per `ProviderInstanceId`. Structured provider APIs emit a
 * challenge directly; CLI-only providers stream a PTY isolated to the
 * instance's home.
 */
import * as Schema from "effect/Schema";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const ProviderLoginColsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(1000),
);
const ProviderLoginRowsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(500),
);

export const ProviderLoginStartInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  cols: Schema.optional(ProviderLoginColsSchema),
  rows: Schema.optional(ProviderLoginRowsSchema),
});
export type ProviderLoginStartInput = Schema.Codec.Encoded<typeof ProviderLoginStartInput>;

export const ProviderLoginWriteInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  data: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
});
export type ProviderLoginWriteInput = Schema.Codec.Encoded<typeof ProviderLoginWriteInput>;

export const ProviderLoginResizeInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  cols: ProviderLoginColsSchema,
  rows: ProviderLoginRowsSchema,
});
export type ProviderLoginResizeInput = Schema.Codec.Encoded<typeof ProviderLoginResizeInput>;

export const ProviderLoginCancelInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type ProviderLoginCancelInput = Schema.Codec.Encoded<typeof ProviderLoginCancelInput>;

/**
 * A `started` event marks the login PTY as running. `commandLabel` is a
 * human-readable description of the spawned command (e.g. `codex login
 * --device-auth`) and MUST never contain secrets — it is only the argv.
 */
const ProviderLoginStartedEvent = Schema.Struct({
  type: Schema.Literal("started"),
  instanceId: Schema.String.check(Schema.isNonEmpty()),
  driver: ProviderDriverKind,
  commandLabel: Schema.String,
});

const ProviderLoginOutputEvent = Schema.Struct({
  type: Schema.Literal("output"),
  data: Schema.String,
});

const ProviderLoginChallengeEvent = Schema.Struct({
  type: Schema.Literal("challenge"),
  url: Schema.String.check(Schema.isNonEmpty()),
  code: Schema.String.check(Schema.isNonEmpty()),
});

const ProviderLoginExitedEvent = Schema.Struct({
  type: Schema.Literal("exited"),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
});

const ProviderLoginErrorEvent = Schema.Struct({
  type: Schema.Literal("error"),
  message: Schema.String.check(Schema.isNonEmpty()),
});

export const ProviderLoginStreamEvent = Schema.Union([
  ProviderLoginStartedEvent,
  ProviderLoginChallengeEvent,
  ProviderLoginOutputEvent,
  ProviderLoginExitedEvent,
  ProviderLoginErrorEvent,
]);
export type ProviderLoginStreamEvent = typeof ProviderLoginStreamEvent.Type;

export class ProviderLoginInstanceNotFoundError extends Schema.TaggedError<ProviderLoginInstanceNotFoundError>()(
  "ProviderLoginInstanceNotFoundError",
  {
    instanceId: Schema.String,
  },
) {
  override get message() {
    return `Unknown provider instance: ${this.instanceId}`;
  }
}

export class ProviderLoginUnsupportedDriverError extends Schema.TaggedError<ProviderLoginUnsupportedDriverError>()(
  "ProviderLoginUnsupportedDriverError",
  {
    instanceId: Schema.String,
    driver: Schema.String,
  },
) {
  override get message() {
    return `Driver '${this.driver}' does not support in-app login for instance: ${this.instanceId}`;
  }
}

export class ProviderLoginSpawnError extends Schema.TaggedError<ProviderLoginSpawnError>()(
  "ProviderLoginSpawnError",
  {
    instanceId: Schema.String,
    detail: Schema.String,
  },
) {
  override get message() {
    return `Failed to start login for provider instance ${this.instanceId}: ${this.detail}`;
  }
}

export class ProviderLoginNotRunningError extends Schema.TaggedError<ProviderLoginNotRunningError>()(
  "ProviderLoginNotRunningError",
  {
    instanceId: Schema.String,
  },
) {
  override get message() {
    return `No active login session for provider instance: ${this.instanceId}`;
  }
}

export class ProviderLoginWriteError extends Schema.TaggedError<ProviderLoginWriteError>()(
  "ProviderLoginWriteError",
  {
    instanceId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to write to login session for provider instance: ${this.instanceId}`;
  }
}

export const ProviderLoginError = Schema.Union([
  ProviderLoginInstanceNotFoundError,
  ProviderLoginUnsupportedDriverError,
  ProviderLoginSpawnError,
  ProviderLoginNotRunningError,
  ProviderLoginWriteError,
]);
export type ProviderLoginError = typeof ProviderLoginError.Type;
