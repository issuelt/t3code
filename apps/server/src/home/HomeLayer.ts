import * as Layer from "effect/Layer";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as FleetBroker from "./FleetBroker.ts";
import * as FleetService from "./FleetService.ts";
import * as HomeService from "./HomeService.ts";
import * as HomeWorkspace from "./HomeWorkspace.ts";

/** Home and fleet services, shared by the WebSocket and MCP transports. */
export const HomeLayer = Layer.mergeAll(
  HomeService.layer,
  FleetService.layer.pipe(Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry)),
).pipe(Layer.provideMerge(FleetBroker.layer), Layer.provideMerge(HomeWorkspace.layer));
