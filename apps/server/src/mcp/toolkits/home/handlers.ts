import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as FleetBroker from "../../../home/FleetBroker.ts";
import * as HomeService from "../../../home/HomeService.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { callerIsHome, readHomeChangeCaller } from "../../homeRouting.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { HomeToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(HomeToolkit, {
  t3_environment_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { scope } = yield* readCaller();
      const environment = yield* ServerEnvironment.ServerEnvironment;
      const descriptor = yield* environment.getDescriptor;
      const current = {
        environmentId: scope.environmentId,
        label: descriptor.label,
        connected: true,
        current: true,
      };
      if (!(yield* callerIsHome())) {
        return {
          currentEnvironmentId: scope.environmentId,
          relayConnected: false,
          environments: [current],
        };
      }
      const reach = yield* (yield* FleetBroker.FleetBroker).reach;
      const desktop = reach.environments.filter(
        (candidate) => candidate.environmentId !== scope.environmentId,
      );
      // Home's thread tools also reach these through their peer links.
      const peerLinks = yield* Effect.serviceOption(PeerLinks.PeerLinks);
      const linked = Option.isNone(peerLinks)
        ? []
        : yield* peerLinks.value.list.pipe(Effect.orElseSucceed(() => []));
      return {
        currentEnvironmentId: scope.environmentId,
        relayConnected: reach.hostConnected,
        environments: [
          current,
          ...desktop.map((candidate) => {
            const link = linked.find((entry) => entry.environmentId === candidate.environmentId);
            return {
              ...candidate,
              connected: candidate.connected || link?.status === "reachable",
              current: false,
            };
          }),
          ...linked
            .filter(
              (link) =>
                link.environmentId !== scope.environmentId &&
                !desktop.some((candidate) => candidate.environmentId === link.environmentId),
            )
            .map((link) => ({
              environmentId: link.environmentId,
              label: link.label,
              connected: link.status === "reachable",
              current: false,
            })),
        ],
      };
    }),
  ),

  t3_thread_watch: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      if (!(yield* callerIsHome()))
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only Home can watch threads.",
        });
      const { scope } = yield* readHomeChangeCaller();
      const homeThreadId = scope.thread?.threadId;
      if (homeThreadId === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only Home can watch threads.",
        });
      const home = yield* HomeService.HomeService;
      const environmentId = input.environmentId ?? scope.environmentId;
      const { threadId } = input;
      if ((input.action === "watch" || input.action === "unwatch") && threadId === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `${input.action} needs threadId.`,
        });
      const next = yield* home
        .updateWatches(homeThreadId, (current) => {
          switch (input.action) {
            case "watch_all":
              return { ...current, watchAll: true };
            case "unwatch_all":
              return { ...current, watchAll: false };
            case "watch":
              return HomeService.addWatch(current, {
                environmentId,
                threadId: threadId!,
                reason: "requested",
              });
            case "unwatch":
              return HomeService.removeWatch(current, { environmentId, threadId: threadId! });
          }
        })
        .pipe(Effect.mapError(unavailable));
      return { watchAll: next.watchAll, watches: next.watches };
    }),
  ),
});
