import {
  buildFleetBoard,
  type FleetJobGroup,
  isFleetChief,
} from "@t3tools/client-runtime/state/fleetBoard";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { liveShellEnvironmentIdsAtom } from "./home";
import { environmentThreadShells } from "./threads";

function sameBoard(left: ReadonlyArray<FleetJobGroup>, right: ReadonlyArray<FleetJobGroup>) {
  return (
    left.length === right.length &&
    left.every((group, index) => {
      const other = right[index]!;
      return (
        group.job === other.job &&
        group.chiefs.length === other.chiefs.length &&
        group.chiefs.every(
          (chief, row) =>
            chief.shell === other.chiefs[row]!.shell &&
            chief.environmentConnected === other.chiefs[row]!.environmentConnected,
        )
      );
    })
  );
}

export const fleetBoardAtom = Atom.make((get) => {
  const next = buildFleetBoard(
    get(environmentThreadShells.quietThreadShellsAtom),
    get(liveShellEnvironmentIdsAtom),
  );
  const previous = Option.getOrNull(get.self<ReadonlyArray<FleetJobGroup>>());
  return previous !== null && sameBoard(previous, next) ? previous : next;
}).pipe(Atom.withLabel("web-fleet-board"));

export const hasFleetChiefsAtom = Atom.make((get) =>
  get(environmentThreadShells.quietThreadShellsAtom).some(isFleetChief),
).pipe(Atom.withLabel("web-fleet-board-has-chiefs"));
