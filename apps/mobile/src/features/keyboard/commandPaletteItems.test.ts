import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import {
  commandPaletteEntityItems,
  filterCommandPaletteItems,
  type CommandPaletteItem,
} from "./commandPaletteItems";

const NOW = Date.UTC(2026, 9, 23);

function item(
  key: string,
  title: string,
  kind: CommandPaletteItem["kind"],
  searchTerms: string[] = [],
): CommandPaletteItem {
  return {
    key,
    title,
    kind,
    searchTerms,
    ...(kind === "thread" ? { threadSearch: { title, activityAt: NOW } } : {}),
    run: () => {},
  };
}

const items = [
  item("new", "New thread in…", "action", ["project", "create"]),
  item("settings", "Open settings", "action", ["preferences"]),
  item("project", "Mobile app", "project", ["/workspaces/mobile", "new thread"]),
  item("siva:one", "Keyboard shortcuts", "thread"),
  item("mac:one", "Mobile app layout", "thread"),
];
const keys = (results: ReadonlyArray<{ readonly key: string }>) =>
  results.map((entry) => entry.key);

describe("filterCommandPaletteItems", () => {
  it("ranks like the web palette, whole words first, with every token required", () => {
    // A thread active today outranks a project that matches as well, but not
    // one whose whole name was typed.
    expect(keys(filterCommandPaletteItems(items, "mobile", [], NOW))).toEqual([
      "mac:one",
      "project",
    ]);
    expect(keys(filterCommandPaletteItems(items, " MOBILE app ", [], NOW))).toEqual([
      "project",
      "mac:one",
    ]);
    expect(keys(filterCommandPaletteItems(items, "keyboard short", [], NOW))).toEqual(["siva:one"]);
  });

  it("lists message matches after the other results, once, except in actions-only mode", () => {
    const results = filterCommandPaletteItems(items, "layout", ["siva:one", "mac:one"], NOW);
    expect(results.map((entry) => [entry.key, entry.fromMessages ?? false])).toEqual([
      ["mac:one", false],
      ["siva:one", true],
    ]);
    expect(filterCommandPaletteItems(items, "> layout", ["siva:one"], NOW)).toEqual([]);
  });
});

describe("commandPaletteEntityItems", () => {
  it("offers no new thread in Home's folder but still names Home on its threads", () => {
    const mac = EnvironmentId.make("mac");
    const project = (id: string, workspaceRoot: string): EnvironmentProject => ({
      environmentId: mac,
      id: ProjectId.make(id),
      title: id === "home" ? "Home" : "App",
      workspaceRoot,
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    const homeThread = makeThreadShellFixture({
      environmentId: mac,
      id: ThreadId.make("home:older"),
      projectId: ProjectId.make("home"),
      title: "Weekly sweep",
    });
    const { activeProject, projectItems, threadItems } = commandPaletteEntityItems({
      projects: [project("home", "/data/home"), project("app", "/work/app")],
      serverConfigs: new Map([[mac, { homeWorkspaceRoot: "/data/home" }]]),
      threads: [homeThread],
      activeThread: homeThread,
      environmentLabel: () => "mac",
      searchEnvironments: false,
      openDraft: () => {},
      openThread: () => {},
    });

    expect(projectItems.map((item) => item.title)).toEqual(["App"]);
    expect(activeProject).toBeNull();
    expect(threadItems[0]?.detail).toBe("Home · mac");
    expect(filterCommandPaletteItems(threadItems, "Home", [], NOW).map((item) => item.key)).toEqual(
      [threadItems[0]?.key],
    );
  });
});
