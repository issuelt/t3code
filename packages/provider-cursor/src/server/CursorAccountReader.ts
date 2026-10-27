import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";

import type { CursorCredentialSource } from "./accountCache.ts";
import {
  readCursorAccountUsage,
  readCursorCredential,
  type CursorResolvedCredential,
  type CursorAccountUsageReadResult,
} from "./accountUsage.ts";
import * as CursorKeychain from "./CursorKeychain.ts";

export class CursorAccountReader extends Context.Service<
  CursorAccountReader,
  {
    readonly resolve: (source: CursorCredentialSource) => Effect.Effect<CursorResolvedCredential>;
    readonly read: (
      credentialSource: CursorCredentialSource | CursorResolvedCredential,
      sinceMs: number,
      untilMs: number,
    ) => Effect.Effect<CursorAccountUsageReadResult>;
  }
>()("@t3tools/provider-cursor/server/CursorAccountReader") {}

export const layer = Layer.effect(
  CursorAccountReader,
  Effect.gen(function* () {
    const keychain = yield* CursorKeychain.CursorKeychain;
    const context = yield* Effect.context<
      FileSystem.FileSystem | Crypto.Crypto | HttpClient.HttpClient
    >();
    return CursorAccountReader.of({
      resolve: Effect.fn("CursorAccountReader.resolve")((source) =>
        readCursorCredential(source, CursorKeychain.freshAccessToken(keychain)).pipe(
          Effect.provideContext(context),
        ),
      ),
      // Only a Keychain login asks the Keychain. The dashboard reader turns
      // its outcome, a failure included, into the source's message.
      read: Effect.fn("CursorAccountReader.read")(function (credentialSource, sinceMs, untilMs) {
        return readCursorAccountUsage(
          credentialSource,
          sinceMs,
          untilMs,
          keychain.accessToken,
        ).pipe(Effect.provideContext(context));
      }),
    });
  }),
);
