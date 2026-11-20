import { createHomeEnvironmentAtoms } from "@t3tools/client-runtime/state/home";

import { connectionAtomRuntime } from "../connection/runtime";

export const homeEnvironment = createHomeEnvironmentAtoms(connectionAtomRuntime);
