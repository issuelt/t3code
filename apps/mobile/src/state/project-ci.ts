import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { readProjectCi, readProjectCiRun } from "../rpc/project-ci";
import { connectionAtomRuntime } from "../connection/runtime";

export const projectCiRead = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile.projectCi.read",
  tag: "projectCi.read",
  staleTimeMs: 30_000,
  idleTtlMs: 60_000,
  execute: readProjectCi,
});

export const projectCiRunRead = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile.projectCi.readRun",
  tag: "projectCi.readRun",
  staleTimeMs: 30_000,
  idleTtlMs: 60_000,
  execute: readProjectCiRun,
});
