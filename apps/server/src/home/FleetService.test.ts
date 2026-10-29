import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  RunId,
  type FleetInput,
  type ExecutionEnvironmentDescriptor,
  type Project as ContractProject,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as HomeWorkspace from "./HomeWorkspace.ts";
import * as Project from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as Repositories from "../sourceControl/SourceControlRepositoryService.ts";
import * as FleetService from "./FleetService.ts";
import { isCoordinationRun, requestResults } from "../orchestration-v2/CoordinationDelivery.ts";

const actor = { environmentId: EnvironmentId.make("hub"), threadId: ThreadId.make("home") };
const threadId = ThreadId.make("worker");
const approvalId = RuntimeRequestId.make("approval");
const questionId = RuntimeRequestId.make("question");
const toolCallId = RuntimeRequestId.make("tool-call");

const shell = (
  id: string,
  projectId: string,
  updatedAt: number,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
) =>
  ({
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    title: id,
    createdBy: "user",
    creationSource: "web",
    status: "idle",
    activityRunStatus: null,
    latestRunId: null,
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    settledOverride: null,
    settledAt: null,
    pendingRuntimeRequest: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: null },
    visibleItemCount: 0,
    deletedAt: null,
    createdAt: DateTime.makeUnsafe(updatedAt),
    updatedAt: DateTime.makeUnsafe(updatedAt),
    ...overrides,
  }) as unknown as OrchestrationV2ThreadShell;

const setup = () => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
  const sent: Array<ThreadManagement.ThreadManagementSendInput> = [];
  const cloned: Array<FleetInput<"projects.clone">> = [];
  const searched: Array<FleetInput<"threads.search">> = [];
  const layer = FleetService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(Repositories.SourceControlRepositoryService)({
          cloneRepository: (input) => {
            cloned.push(input);
            return Effect.succeed({ path: input.destinationPath } as never);
          },
        }),
        Layer.mock(ThreadSearch.ThreadSearch)({
          searchThreads: (input) => {
            searched.push(input);
            return Effect.succeed({
              matches: [
                {
                  threadId: ThreadId.make("found"),
                  projectId: ProjectId.make("a"),
                  title: "Found",
                  source: "title",
                },
              ],
            } as never);
          },
        }),
        ServerSettings.layerTest(),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("studio"),
          } as ExecutionEnvironmentDescriptor),
        }),
        Layer.mock(Project.ProjectService)({
          getById: (projectId) =>
            Effect.succeedSome({
              id: projectId,
              workspaceRoot: `/${projectId}`,
            } as ContractProject),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
        }),
        Layer.mock(HomeWorkspace.HomeWorkspace)({
          root: "/home",
          contains: (candidate) =>
            Effect.succeed(candidate === "/home" || candidate.startsWith("/home/")),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) => {
            launched.push(input);
            return Effect.succeed({
              projection: {
                thread: {
                  id: input.threadId,
                  title: input.title,
                  projectId: input.projectId,
                  modelSelection: input.modelSelection,
                },
                runs: [],
              },
            } as never);
          },
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          registerCoordinationRequest: () => Effect.void,
          deliverCoordinationResult: (input, actor) => {
            sent.push({
              threadId: input.threadId,
              coordination: { kind: "response", requestMessageId: input.requestMessageId },
              text: input.text,
              senderThreadId: actor.threadId,
            } as ThreadManagement.ThreadManagementSendInput);
            return Effect.succeed({
              message: { id: MessageId.make("reply") },
              run: { id: RunId.make("reply-run"), status: "queued" },
              delivery: "queued",
            } as ThreadManagement.ThreadManagementSendResult);
          },
          getThreadShell: (id) => Effect.succeed(shell(id, "a", 1)),
          sendToThread: (input) => {
            sent.push(input);
            return Effect.succeed({
              run: { id: RunId.make("sent-run"), status: "queued" },
              delivery: "queued",
            } as never);
          },
          getThreadProjection: (id) => Effect.succeed({ thread: shell(id, "a", 1) } as never),
          waitForThread: (input) =>
            Effect.succeed({ threadId: input.threadId, run: null, timedOut: false }),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [
                shell("older", "a", 1),
                shell("newer", "b", 2),
                // The test clock starts at 0, so this one wakes in a minute.
                shell("snoozed", "a", 0, {
                  snoozedAt: DateTime.makeUnsafe(0),
                  snoozedUntil: DateTime.makeUnsafe(60_000),
                }),
              ],
              archivedThreads: [],
            }),
          getThreadRecords: () =>
            Effect.succeed({
              runtimeRequests: [
                { id: approvalId, kind: "command", status: "pending" },
                { id: questionId, kind: "user_input", status: "pending" },
                { id: toolCallId, kind: "dynamic_tool_call", status: "pending" },
              ],
              turnItems: [],
            } as never),
          dispatch: (command) => {
            dispatched.push(command);
            return Effect.succeed({ sequence: 7, storedEvents: [] } as never);
          },
        }),
      ),
    ),
  );
  return { layer, dispatched, launched, sent, cloned, searched };
};

it.effect("lists threads from every project, newest first, with snooze state", () => {
  const { layer } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const result = yield* fleet.execute({ actor, request: { op: "threads.list", input: {} } });
    expect(result).toMatchObject({
      projectId: null,
      threads: [
        {
          threadId: "newer",
          link: "[newer](t3-thread://v1/newer?environmentId=studio)",
          projectId: "b",
          snoozed: false,
          snoozedUntil: null,
        },
        { threadId: "older", projectId: "a" },
        { threadId: "snoozed", snoozed: true, snoozedUntil: "1970-01-01T00:01:00.000Z" },
      ],
    });
    const snoozed = yield* fleet.execute({
      actor,
      request: { op: "threads.list", input: { snoozed: true } },
    });
    expect(snoozed).toMatchObject({ total: 1, threads: [{ threadId: "snoozed" }] });
  }).pipe(Effect.provide(layer));
});

it.effect("clones and searches in the environment that runs the operation", () => {
  const { layer, cloned, searched } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const clone = {
      remoteUrl: "https://github.com/issuelt/t3code.git",
      destinationPath: "/srv/t3code",
    } as FleetInput<"projects.clone">;
    yield* fleet.execute({ actor, request: { op: "projects.clone", input: clone } });
    expect(cloned).toEqual([clone]);
    const result = yield* fleet.execute({
      actor,
      request: { op: "threads.search", input: { query: "fleet" } },
    });
    expect(searched).toEqual([{ query: "fleet" }]);
    expect(result).toEqual({
      matches: [
        {
          threadId: "found",
          projectId: "a",
          title: "Found",
          source: "title",
          link: "[Found](t3-thread://v1/found?environmentId=studio)",
        },
      ],
    });
  }).pipe(Effect.provide(layer));
});

it.effect("approves a pending request with a decision", () => {
  const { layer, dispatched } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const listed = yield* fleet.execute({
      actor,
      request: { op: "requests.list", input: { threadId } },
    });
    expect(listed).toEqual({ requestIds: [questionId], approvalRequestIds: [approvalId] });
    yield* fleet.execute({
      actor,
      request: {
        op: "requests.respond",
        input: { threadId, requestId: approvalId, decision: "accept" },
      },
    });
    expect(dispatched).toMatchObject([
      { type: "runtime-request.respond", threadId, requestId: approvalId, decision: "accept" },
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses to answer a question without answers", () => {
  const { layer, dispatched } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const error = yield* fleet
      .execute({
        actor,
        request: {
          op: "requests.respond",
          input: { threadId, requestId: questionId, decision: "accept" },
        },
      })
      .pipe(Effect.asVoid, Effect.flip);
    expect(error.code).toBe("invalid_request");
    expect(dispatched).toHaveLength(0);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses a scratch launch that also names a workspace", () => {
  const { layer } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const error = yield* fleet
      .execute({
        actor,
        request: {
          op: "threads.launch",
          input: {
            scratch: true,
            title: "Scratch work",
            workspaceStrategy: { type: "existing_worktree", worktreePath: "/elsewhere" },
          },
        },
      })
      .pipe(Effect.asVoid, Effect.flip);
    expect(error.code).toBe("invalid_request");
  }).pipe(Effect.provide(layer));
});

it.effect("refuses to launch into a Home folder, as a project or a worktree", () => {
  const { layer } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const launch = (input: Omit<FleetInput<"threads.launch">, "title">) =>
      fleet
        .execute({ actor, request: { op: "threads.launch", input: { title: "Worker", ...input } } })
        .pipe(Effect.asVoid, Effect.flip);
    expect((yield* launch({ projectId: ProjectId.make("home") })).code).toBe("invalid_request");
    const worktree = yield* launch({
      projectId: ProjectId.make("app"),
      workspaceStrategy: { type: "existing_worktree", worktreePath: "/home/notes" },
    });
    expect(worktree.code).toBe("invalid_request");
  }).pipe(Effect.provide(layer));
});

it.effect("keys a retried rename by its target thread", () => {
  const { layer, dispatched } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const rename = (target: string) =>
      fleet
        .execute({
          actor,
          request: {
            op: "threads.rename",
            input: { threadId: ThreadId.make(target), title: "New title", clientRequestId: "r1" },
          },
        })
        .pipe(Effect.ignore);
    yield* rename("a");
    yield* rename("a");
    yield* rename("b");
    const ids = dispatched.map((command) => command.commandId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses a decision for a request that is not an approval", () => {
  const { layer, dispatched } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const error = yield* fleet
      .execute({
        actor,
        request: {
          op: "requests.respond",
          input: { threadId, requestId: toolCallId, decision: "accept" },
        },
      })
      .pipe(Effect.asVoid, Effect.flip);
    expect(error.code).toBe("invalid_request");
    expect(dispatched).toHaveLength(0);
  }).pipe(Effect.provide(layer));
});

it.effect("only launches with a Home launch id it was given", () => {
  const { layer } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const error = yield* fleet
      .execute({
        actor,
        request: {
          op: "threads.launch",
          input: { threadId: ThreadId.make("home:fake"), scratch: true, title: "Worker" },
        },
      })
      .pipe(Effect.asVoid, Effect.flip);
    expect(error.code).toBe("invalid_request");
  }).pipe(Effect.provide(layer));
});

it.effect("replays a Home launch with the same thread id", () => {
  const { layer, launched } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const input = {
      threadId: ThreadId.make("home-launched:retry"),
      projectId: ProjectId.make("app"),
      title: "Worker",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      message: "Work",
    };
    yield* fleet.execute({ actor, request: { op: "threads.launch", input } });
    yield* fleet.execute({ actor, request: { op: "threads.launch", input } });
    expect(launched[0]?.commandId).toBe(launched[1]?.commandId);
    expect(launched[0]?.initialMessage?.messageId).toBe(launched[1]?.initialMessage?.messageId);
  }).pipe(Effect.provide(layer));
});

it.effect("waits for a thread in another project", () => {
  const { layer } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const result = yield* fleet.execute({
      actor,
      request: { op: "threads.wait", input: { threadId } },
    });
    expect(result).toMatchObject({ threadId, runId: null, status: "idle", timedOut: false });
  }).pipe(Effect.provide(layer));
});

it("routes each request to its own environment and thread without replying to responses", () => {
  const first = { kind: "request", requester: actor } as const;
  const second = {
    kind: "request",
    requester: { environmentId: EnvironmentId.make("remote"), threadId: ThreadId.make("other") },
  } as const;
  const messages = [
    { id: MessageId.make("a"), coordination: first },
    { id: MessageId.make("b"), coordination: second },
    {
      id: MessageId.make("reply"),
      coordination: {
        kind: "response",
        requestMessageId: MessageId.make("old"),
        sourceRunId: RunId.make("old-run"),
      },
    },
  ] satisfies Parameters<typeof requestResults>[0]["messages"];
  const input = {
    messages,
    sourceRunId: RunId.make("finished"),
    text: "The dependency is pinned.",
  };
  expect(requestResults(input)).toEqual([
    {
      requester: actor,
      requestMessageId: MessageId.make("a"),
      sourceRunId: input.sourceRunId,
      text: input.text,
    },
    {
      requester: second.requester,
      requestMessageId: MessageId.make("b"),
      sourceRunId: input.sourceRunId,
      text: input.text,
    },
  ]);
  expect(requestResults(input)).toEqual(requestResults(input));
  expect(requestResults({ ...input, messages: messages.slice(2) })).toEqual([]);
});

it.effect(
  "registers fleet requests with their caller and scopes retry keys to concurrent callers",
  () => {
    const { layer, sent } = setup();
    return Effect.gen(function* () {
      const fleet = yield* FleetService.FleetService;
      const request = {
        op: "threads.send",
        input: { threadId, message: "Which dependency is pinned?", clientRequestId: "question" },
      } as const;
      yield* fleet.execute({ actor, request });
      yield* fleet.execute({ actor, request });
      const other = { environmentId: EnvironmentId.make("remote"), threadId: actor.threadId };
      yield* fleet.execute({ actor: other, request });
      expect(sent[0]).toMatchObject({
        coordination: { kind: "request", requester: actor },
        mode: "queue",
      });
      expect(sent[1]?.commandId).toBe(sent[0]?.commandId);
      expect(sent[2]?.commandId).not.toBe(sent[0]?.commandId);
      expect(sent[2]?.coordination).toEqual({ kind: "request", requester: other });
    }).pipe(Effect.provide(layer));
  },
);

it("keeps a genuine user turn reportable when coordination input is steered into it", () => {
  const request = {
    role: "user",
    coordination: { kind: "request", requester: actor },
  } satisfies Parameters<typeof isCoordinationRun>[0][number];
  const response = {
    role: "user",
    coordination: {
      kind: "response",
      requestMessageId: MessageId.make("request"),
      sourceRunId: RunId.make("source"),
    },
  } satisfies Parameters<typeof isCoordinationRun>[0][number];
  expect(isCoordinationRun([request])).toBe(true);
  expect(isCoordinationRun([response])).toBe(false);
  expect(
    isCoordinationRun([{ ...response, coordination: { ...response.coordination, owner: "job" } }]),
  ).toBe(false);
  expect(
    isCoordinationRun([
      { ...response, coordination: { ...response.coordination, owner: "coordination" } },
    ]),
  ).toBe(true);
  expect(isCoordinationRun([request, { role: "user" }])).toBe(false);
  expect(isCoordinationRun([])).toBe(false);
});

it.effect("sends a correlated manual answer without creating another request", () => {
  const { layer, sent } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    yield* fleet.execute({
      actor,
      request: {
        op: "threads.send",
        input: {
          threadId,
          message: "The pin is 3.",
          replyToMessageId: MessageId.make("incoming-request"),
        },
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.coordination).toEqual({
      kind: "response",
      requestMessageId: "incoming-request",
    });
  }).pipe(Effect.provide(layer));
});
