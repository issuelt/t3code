import {
  layerSocketless,
  respondToRuntimeRequestOverHttp,
} from "@t3tools/client-runtime/state/runtime-request-http";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import * as ConnectionPlatform from "../../connection/platform";
import type { ApprovalAnswer } from "./approvalActions";

// Only the resolver and stored credentials: answering from a notification opens no socket.
const runtime = ManagedRuntime.make(
  layerSocketless.pipe(Layer.provideMerge(ConnectionPlatform.layer)),
);

export function answerApproval(answer: ApprovalAnswer) {
  return runtime.runPromise(respondToRuntimeRequestOverHttp(answer));
}
