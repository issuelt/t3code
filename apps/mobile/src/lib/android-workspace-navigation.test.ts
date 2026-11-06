import * as NodeModule from "node:module";
import type { NavigationState } from "@react-navigation/native";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  androidWorkspaceTabNavigationState,
  type AndroidWorkspaceNavigationTab,
} from "../features/layout/workspace/android-workspace-tabs";
import {
  linkedThreadStep,
  parentThreadIsBelow,
  resetAndroidWorkspace,
  returnToAndroidWorkspaceList,
} from "./android-workspace-navigation";
import type { RootStackResetAction } from "./root-stack-reset";

function loadRouters() {
  const require = NodeModule.createRequire(import.meta.url);
  const nativePackage = require.resolve("@react-navigation/native/package.json");
  const corePackage = NodeModule.createRequire(nativePackage).resolve(
    "@react-navigation/core/package.json",
  );
  return NodeModule.createRequire(corePackage)("@react-navigation/routers") as {
    readonly CommonActions: typeof import("@react-navigation/native").CommonActions;
    readonly StackActions: typeof import("@react-navigation/native").StackActions;
    readonly StackRouter: typeof import("@react-navigation/native").StackRouter;
  };
}

vi.mock("@react-navigation/native", () => ({
  ...loadRouters(),
  useNavigation: () => navigation,
  useRoute: () => current.routes[current.index],
  useFocusEffect: (callback: () => unknown) => callback(),
}));
vi.mock("react", () => ({ useCallback: (callback: unknown) => callback }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  Keyboard: { isVisible: () => false },
  BackHandler: {
    addEventListener: (_event: string, callback: () => boolean) => {
      hardwareBack = callback;
      return { remove: () => {} };
    },
  },
}));
vi.mock("../features/layout/workspace/WorkspaceTabsContext", () => ({
  useWorkspaceTabs: () => ({ dispatch: selectTab }),
}));
vi.mock("../state/entities", () => ({
  useThreadShell: () => ({ projectId: "project-a" }),
  useProjects: () => [],
}));
vi.mock("../features/layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => (detail: typeof pullRequest) => {
    current = apply(
      current,
      CommonActions.reset({
        stale: true,
        index: 1,
        routes: [{ name: "Home", key: current.routes[0]?.key }, detail],
      }),
    );
  },
}));
vi.mock("../state/atom-registry", () => ({ appAtomRegistry: { get: () => new Map() } }));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../state/use-thread-pr", () => ({
  withKnownPullRequestSummary: <T>(destination: T) => destination,
}));
vi.mock("./pullRequestNavigation", () => ({
  nativePullRequestDestination: (_url: string, context: object) => ({
    ...pullRequest.params,
    ...context,
  }),
}));
vi.mock("./openExternalUrl", () => ({ tryOpenExternalUrl: vi.fn() }));

import { useOpenPullRequest } from "../native/useOpenPullRequest";
import {
  useAndroidWorkspaceBack,
  useWorkspaceListNavigation,
} from "../features/layout/workspace/useAndroidWorkspaceNavigation";

const { CommonActions, StackActions, StackRouter } = loadRouters();
const router = StackRouter({});
const options = {
  routeNames: [
    "Home",
    "Thread",
    "ThreadFiles",
    "ThreadTerminal",
    "GitOverview",
    "PullRequest",
    "PullRequestFile",
    "PullRequestReviewers",
    "Settings",
    "SettingsEnvironments",
    "SettingsAppearance",
    "SettingsOpenSourceLicenses",
    "SettingsUsage",
    "SettingsUsageAccount",
  ],
  routeParamList: {},
  routeGetIdList: {},
};
const thread = {
  name: "Thread",
  params: { environmentId: "environment-a", threadId: "thread-a" },
} as const;
const pullRequest = {
  name: "PullRequest",
  params: {
    environmentId: "environment-a",
    projectId: "project-a",
    repository: "owner/repository",
    number: 42,
    host: "github.com",
  },
} as const;

function apply(
  state: ReturnType<typeof router.getInitialState>,
  action: Parameters<typeof router.getStateForAction>[1],
) {
  const result = router.getStateForAction(state, action, options);
  if (!result) throw new Error(`Router rejected ${action.type}`);
  return router.getRehydratedState(result, options);
}

function withThread() {
  return apply(router.getInitialState(options), StackActions.push(thread.name, thread.params));
}

function legacyHistory() {
  let state = router.getInitialState(options);
  state = apply(state, StackActions.push(thread.name, thread.params));
  state = apply(state, StackActions.push(pullRequest.name, pullRequest.params));
  return state;
}

function names(state: ReturnType<typeof router.getInitialState>) {
  return state.routes.map((route) => route.name);
}

let current = router.getInitialState(options);
let hardwareBack: (() => boolean) | undefined;
const selectTab = vi.fn();
type RouterAction = Parameters<typeof router.getStateForAction>[1];
const navigation = {
  getState: () => current,
  getParent: () => undefined,
  canGoBack: () => router.getStateForAction(current, CommonActions.goBack(), options) !== null,
  goBack: () => {
    current = apply(current, CommonActions.goBack());
  },
  navigate: (name: string, params: object) => {
    current = apply(current, CommonActions.navigate(name, params));
  },
  dispatch: (action: RouterAction | ((state: NavigationState) => RouterAction)) => {
    current = apply(current, typeof action === "function" ? action(current) : action);
  },
};

beforeEach(() => {
  current = router.getInitialState(options);
  hardwareBack = undefined;
  selectTab.mockClear();
});

describe("Android workspace navigation", () => {
  it("returns to a distinct previous thread, otherwise to the workspace list", () => {
    const parent = withThread();
    let state = apply(
      parent,
      StackActions.push("Thread", { ...thread.params, threadId: "child-a" }),
    );
    let listSelected = false;
    const navigation = {
      dispatch: (action: RootStackResetAction) => {
        state = apply(state, action);
      },
      getParent: () => undefined,
      getState: () => state,
      goBack: () => {
        state = apply(state, StackActions.pop());
      },
    };
    const back = () =>
      returnToAndroidWorkspaceList(navigation, () => {
        listSelected = true;
      });

    back();
    expect(state.routes).toEqual(parent.routes);
    expect(state.index).toBe(parent.index);
    expect(listSelected).toBe(false);

    back();
    expect(state.routes).toEqual([parent.routes[0]]);
    expect(state.index).toBe(0);
    expect(listSelected).toBe(true);

    state = apply(
      parent,
      StackActions.push("Thread", { ...thread.params, environmentId: "environment-b" }),
    );
    listSelected = false;
    back();
    expect(state.routes).toEqual(parent.routes);
    expect(state.index).toBe(parent.index);
    expect(listSelected).toBe(false);

    // Confirming a Git action from the inline inspector can duplicate the current thread.
    state = apply(parent, StackActions.push("Thread", thread.params));
    back();
    expect({ routes: names(state), index: state.index, listSelected }).toEqual({
      routes: ["Home"],
      index: 0,
      listSelected: true,
    });
  });

  it("opens a linked thread above the current one so Back returns to it", () => {
    const parent = withThread();
    const child = { ...thread.params, threadId: "child-a" };
    const open = (
      state: ReturnType<typeof router.getInitialState>,
      target: ReactNavigation.RootParamList["Thread"],
    ) => {
      const step = linkedThreadStep(state, target);
      if (step === "stay") return state;
      return apply(
        state,
        step === "pop" ? StackActions.pop() : StackActions.push("Thread", target),
      );
    };

    const inChild = open(parent, child);
    expect(inChild.routes.map((route) => route.params)).toEqual([undefined, thread.params, child]);
    expect(open(inChild, child)).toBe(inChild);

    const backInParent = open(inChild, thread.params);
    expect(backInParent.routes).toEqual(parent.routes);
    expect(backInParent.index).toBe(parent.index);
  });

  it("recognizes a parent only when its environment and thread are immediately below", () => {
    const parent = withThread();
    const child = apply(
      parent,
      StackActions.push("Thread", { ...thread.params, threadId: "child-a" }),
    );

    expect(parentThreadIsBelow(child, thread.params)).toBe(true);
    expect(parentThreadIsBelow(child, { ...thread.params, environmentId: "environment-b" })).toBe(
      false,
    );
    expect(parentThreadIsBelow(child, { ...thread.params, threadId: "other" })).toBe(false);
    expect(parentThreadIsBelow(parent, thread.params)).toBe(false);
    expect(
      parentThreadIsBelow(
        apply(child, StackActions.push("Thread", { ...thread.params, threadId: "grandchild-a" })),
        thread.params,
      ),
    ).toBe(false);
  });

  it("resets the root stack when a nested stack has focus", () => {
    const root = apply(router.getInitialState(options), StackActions.push("Thread", thread.params));
    const nested = router.getInitialState({ ...options, routeNames: ["Nested", "NestedChild"] });
    const actions: RootStackResetAction[] = [];
    const rootNavigation = {
      dispatch: () => undefined,
      getParent: () => undefined,
      getState: () => root,
    };
    resetAndroidWorkspace({
      dispatch: (action) => actions.push(action),
      getParent: () => rootNavigation,
      getState: () => nested,
    });
    const [action] = actions;
    expect(action?.target).toBe(root.key);
    expect(names(apply(root, action!))).toEqual(["Home"]);
  });

  it("resets from the navigation container before any navigation action", () => {
    const root = router.getInitialState(options);
    const actions: RootStackResetAction[] = [];
    // The container only learns the root state after the first action.
    resetAndroidWorkspace({
      dispatch: (action) => actions.push(action),
      getParent: () => undefined,
      getState: () => undefined,
      getRootState: () => root,
    });
    const [action] = actions;
    expect(action?.target).toBe(root.key);
    expect(names(apply(root, action!))).toEqual(["Home"]);
  });
});

describe("Android Settings tab", () => {
  type State = ReturnType<typeof router.getInitialState>;
  type Tab = AndroidWorkspaceNavigationTab;
  const openTab = (state: State, tab: Tab, columns = false) =>
    apply(state, CommonActions.reset(androidWorkspaceTabNavigationState(state, tab, columns)));

  it("opens a default Settings page beside the category list in wide layouts", () => {
    const settings = openTab(legacyHistory(), "settings", true);
    expect(names(settings)).toEqual(["Home", "Settings", "SettingsEnvironments"]);
    expect(names(apply(settings, StackActions.pop()))).toEqual(["Home", "Settings"]);
  });

  it("keeps the selected category mounted when reselecting wide Settings", () => {
    let settings = openTab(legacyHistory(), "settings");
    settings = apply(settings, StackActions.push("SettingsAppearance"));
    const category = settings.routes.at(-1);
    settings = apply(settings, StackActions.push("SettingsOpenSourceLicenses"));
    const reselected = openTab(settings, "settings", true);
    expect(names(reselected)).toEqual(["Home", "Settings", "SettingsAppearance"]);
    expect(reselected.routes.at(-1)?.key).toBe(category?.key);
  });

  it("opens over Home alone, dropping chat and PR history, and Back returns to Home", () => {
    const previous = legacyHistory();
    const settings = openTab(previous, "settings");
    expect(names(settings)).toEqual(["Home", "Settings"]);
    expect(settings.routes[0]?.key).toBe(previous.routes[0]?.key);
    const back = apply(settings, StackActions.pop());
    expect(names(back)).toEqual(["Home"]);
    expect(back.routes[0]?.key).toBe(previous.routes[0]?.key);
  });

  it("stays selected under a settings page until a list tab returns to Home", () => {
    const previous = legacyHistory();
    const usage = apply(openTab(previous, "settings"), StackActions.push("SettingsUsage"));
    const list = openTab(usage, "pullRequests");
    expect(names(list)).toEqual(["Home"]);
    expect(list.routes[0]?.key).toBe(previous.routes[0]?.key);
  });
});

describe("Android contextual navigation", () => {
  it.each([false, true])(
    "restores the original chat history after a PR link (replace sheet: %s)",
    async (replace) => {
      current = apply(
        current,
        StackActions.push("Thread", { ...thread.params, environmentId: "environment-b" }),
      );
      current = apply(current, StackActions.push(thread.name, thread.params));
      const previous = current.routes;
      if (replace) current = apply(current, StackActions.push("GitOverview", thread.params));
      await useOpenPullRequest({ replace })("https://github.com/owner/repository/pull/42");
      expect(current.routes.slice(0, -1)).toEqual(previous);
      expect(current.routes.at(-1)).toMatchObject(pullRequest);
      const back = useAndroidWorkspaceBack("pullRequests");
      if (replace) {
        if (!hardwareBack?.()) navigation.goBack();
      } else back();
      expect(current.routes).toEqual(previous);
      expect(selectTab).not.toHaveBeenCalled();
    },
  );

  it("returns through detail history on Back but clears it on an explicit list switch", () => {
    const previous = legacyHistory();
    current = apply(
      previous,
      StackActions.push("Thread", { ...thread.params, environmentId: "environment-b" }),
    );
    useAndroidWorkspaceBack("threads")();
    expect(current.routes).toEqual(previous.routes);
    expect(selectTab).not.toHaveBeenCalled();
    useWorkspaceListNavigation("threads")();
    expect(current.routes).toEqual([previous.routes[0]]);
    expect(selectTab).toHaveBeenLastCalledWith({ type: "select", tab: "threads" });
    expect(navigation.canGoBack()).toBe(false);
  });
});

it.each([false, true])(
  "returns to the PR diff after opening a thread (first send: %s)",
  (draft) => {
    current = legacyHistory();
    current = apply(
      current,
      StackActions.push("PullRequestFile", { ...pullRequest.params, path: "file.ts" }),
    );
    const previous = current.routes;
    current = apply(
      current,
      StackActions.push("Thread", draft ? { draft: { draftId: "pr-draft" } } : thread.params),
    );
    if (draft)
      current = apply(current, CommonActions.setParams({ draft: undefined, ...thread.params }));
    const back = useAndroidWorkspaceBack("threads");
    if (draft) hardwareBack?.();
    else back();
    expect(current.routes).toEqual(previous);
    expect(selectTab).not.toHaveBeenCalled();
  },
);

it("keeps chat history when a PR links to itself", async () => {
  current = withThread();
  const chat = current.routes;
  await useOpenPullRequest()("https://github.com/owner/repository/pull/42");
  const previous = current.routes;
  await useOpenPullRequest()("https://github.com/owner/repository/pull/42");
  useAndroidWorkspaceBack("pullRequests")();
  expect(current.routes).toEqual(previous);
  useAndroidWorkspaceBack("pullRequests")();
  expect(current.routes).toEqual(chat);
  expect(selectTab).not.toHaveBeenCalled();
});
