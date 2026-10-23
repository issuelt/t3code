import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as FleetBroker from "./FleetBroker.ts";
import * as FleetService from "./FleetService.ts";
import * as HomeService from "./HomeService.ts";
import * as HomeWorkspace from "./HomeWorkspace.ts";

/** Home services for tests whose caller is never Home. */
export const notHomeLayer = Layer.mergeAll(
  Layer.mock(HomeWorkspace.HomeWorkspace)({ root: "/home" }),
  Layer.mock(HomeService.HomeService)({
    available: false,
    isHome: () => Effect.succeed(false),
  }),
  Layer.mock(FleetService.FleetService)({}),
  Layer.mock(FleetBroker.FleetBroker)({}),
);
