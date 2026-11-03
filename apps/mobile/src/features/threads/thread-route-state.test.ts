import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";
import {
  draftRouteIdentity,
  isDraftThreadRoute,
  submittedThreadParams,
} from "./thread-route-state";

const requireNavigation = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
);
const { StackRouter, CommonActions, StackActions } = requireNavigation(
  "@react-navigation/routers",
) as {
  StackRouter: typeof import("@react-navigation/native").StackRouter;
  CommonActions: typeof import("@react-navigation/native").CommonActions;
  StackActions: typeof import("@react-navigation/native").StackActions;
};

describe("draft thread handoff", () => {
  it.each(["Home", "PullRequest"])("submits in place and preserves Back to %s", (origin) => {
    const router = StackRouter({});
    const options = {
      routeNames: ["Home", "Thread", "PullRequest"],
      routeParamList: {},
      routeGetIdList: {},
    };
    const initial = router.getInitialState(options);
    const parent =
      origin === "Home"
        ? initial
        : router.getStateForAction(
            initial,
            StackActions.push("PullRequest", { number: 42 }),
            options,
          )!;
    if (parent.stale !== false) throw new Error("Parent route was not initialized");
    const draft = router.getStateForAction(
      parent,
      StackActions.push("Thread", { draft: { projectId: "project" } }),
      options,
    )!;
    if (!draft || draft.stale !== false) throw new Error("Draft route was not initialized");
    expect(isDraftThreadRoute(draft.routes.at(-1))).toBe(true);
    const submitted = router.getStateForAction(
      draft,
      CommonActions.setParams(submittedThreadParams("environment", "thread")),
      options,
    )!;
    if (submitted.stale !== false) throw new Error("Submitted route was not initialized");
    expect(submitted.routes.map((route) => route.key)).toEqual(
      draft.routes.map((route) => route.key),
    );
    expect(submitted.index).toBe(draft.index);
    expect(submitted.routes.at(-1)?.params).toEqual({
      draft: undefined,
      environmentId: "environment",
      threadId: "thread",
    });
    expect(isDraftThreadRoute(submitted.routes.at(-1))).toBe(false);
    expect(router.getStateForAction(submitted, CommonActions.goBack(), options)?.routes).toEqual(
      parent.routes,
    );
  });
});

describe("missing shared-content project recovery", () => {
  it("replaces the stale draft before selecting the replacement project", () => {
    const router = StackRouter({});
    const options = {
      routeNames: ["Home", "Thread", "NewTaskProject"],
      routeParamList: {},
      routeGetIdList: {},
    };
    const initial = router.getInitialState(options);
    const staleDraft = router.getStateForAction(
      initial,
      CommonActions.navigate("Thread", {
        draft: { environmentId: "environment", projectId: "deleted", incomingShareId: "share" },
      }),
      options,
    )!;
    if (staleDraft.stale !== false) throw new Error("Draft route was not initialized");
    const picker = router.getStateForAction(
      staleDraft,
      StackActions.replace("NewTaskProject", { incomingShareId: "share" }),
      options,
    )!;
    if (picker.stale !== false) throw new Error("Project picker was not initialized");
    expect(picker.routes.some(isDraftThreadRoute)).toBe(false);
    expect(picker.routes.at(-1)?.params).toEqual({ incomingShareId: "share" });
    const recovered = router.getStateForAction(
      picker,
      CommonActions.navigate("Thread", {
        draft: { environmentId: "environment", projectId: "replacement", incomingShareId: "share" },
      }),
      options,
    )!;
    expect(recovered.routes.filter(isDraftThreadRoute)).toHaveLength(1);
    expect(recovered.routes.at(-1)?.params).toEqual({
      draft: { environmentId: "environment", projectId: "replacement", incomingShareId: "share" },
    });
  });
});

describe("draft route identity", () => {
  it("changes when a reused Thread route selects another draft or starts a new one", () => {
    const draft = { environmentId: "env", projectId: "project", draftId: "a" };
    expect(draftRouteIdentity(draft)).not.toBe(draftRouteIdentity({ ...draft, draftId: "b" }));
    expect(draftRouteIdentity(draft)).not.toBe(
      draftRouteIdentity({ ...draft, draftId: undefined }),
    );
    expect(draftRouteIdentity(draft)).not.toBe(
      draftRouteIdentity({ ...draft, projectId: "other" }),
    );
    expect(draftRouteIdentity(draft)).not.toBe(
      draftRouteIdentity({ ...draft, incomingShareId: "share" }),
    );
  });

  it("normalizes link parameters without resetting for display metadata", () => {
    expect(
      draftRouteIdentity({ environmentId: ["env"], projectId: ["project"], title: "Old" }),
    ).toBe(draftRouteIdentity({ environmentId: "env", projectId: "project", title: "New" }));
  });
});

it("starts a fresh controller for repeated new-task requests in the same project", () => {
  const project = { environmentId: "env", projectId: "project" };
  expect(draftRouteIdentity({ ...project, requestId: "first" })).not.toBe(
    draftRouteIdentity({ ...project, requestId: "second" }),
  );
});
