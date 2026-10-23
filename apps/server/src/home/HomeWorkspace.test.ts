import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { IsoDateTime, Project, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as HomeWorkspace from "./HomeWorkspace.ts";

it("keeps the user's Home instructions while refreshing T3's section", () => {
  const fresh = HomeWorkspace.refreshHomeAgents(null);
  assert.isNotNull(fresh);
  const edited = fresh!
    .replace("You are Home", "You were Home")
    .concat("\nAlways answer in French.\n");
  const refreshed = HomeWorkspace.refreshHomeAgents(edited);
  assert.include(refreshed!, "You are Home");
  assert.include(refreshed!, "Always answer in French.");
  assert.isNull(HomeWorkspace.refreshHomeAgents(refreshed));
  assert.isNull(HomeWorkspace.refreshHomeAgents("# My own file\n"));
});

it.effect("isolates Home's repository and preserves its notes when preparing it again", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-home-workspace-" });
    const root = path.join(baseDir, "home");
    const project = Project.make({
      id: ProjectId.make("home-project"),
      title: "Home",
      workspaceRoot: root,
      defaultModelSelection: null,
      scripts: [],
      createdAt: IsoDateTime.make("2026-10-23T00:00:00.000Z"),
      updatedAt: IsoDateTime.make("2026-10-23T00:00:00.000Z"),
      deletedAt: null,
    });
    let inits = 0;
    const layer = HomeWorkspace.layer.pipe(
      Layer.provide(ServerConfig.layerTest(baseDir, baseDir)),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            execute: (input) =>
              Effect.gen(function* () {
                assert.equal(input.cwd, root);
                assert.deepEqual(input.args, ["init"]);
                inits++;
                yield* fs.makeDirectory(path.join(root, ".git")).pipe(Effect.orDie);
                return {
                  stdout: "",
                  stderr: "",
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdoutTruncated: false,
                  stderrTruncated: false,
                };
              }),
          }),
          Layer.mock(ProjectService.ProjectService)({
            bootstrap: (input) => {
              assert.equal(input.workspaceRoot, root);
              return Effect.succeed({ project, created: false });
            },
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const workspace = yield* HomeWorkspace.HomeWorkspace;
      assert.equal(workspace.root, root);
      assert.isTrue(yield* workspace.contains(root));
      assert.isTrue(yield* workspace.contains(path.join(root, "notes")));
      assert.isTrue(yield* workspace.contains(path.join(root, "..notes")));
      assert.isFalse(yield* workspace.contains(`${root}work`));
      assert.isFalse(yield* workspace.contains(baseDir));

      yield* workspace.ensureProject;
      assert.equal(yield* fs.readFileString(path.join(root, "CLAUDE.md")), "@AGENTS.md\n");
      const agents = path.join(root, "AGENTS.md");
      yield* fs.writeFileString(agents, (yield* fs.readFileString(agents)) + "\nKeep my notes.\n");
      yield* fs.writeFileString(path.join(root, "notes.md"), "A durable note.");
      yield* workspace.ensureProject;
      assert.equal(inits, 1);
      assert.include(yield* fs.readFileString(agents), "Keep my notes.");
      assert.equal(yield* fs.readFileString(path.join(root, "notes.md")), "A durable note.");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);
