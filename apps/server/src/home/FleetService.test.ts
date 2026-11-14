import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  FleetThreadSearchResult,
  MessageId,
  OrchestratorMcpThreadReadResult,
  RunId,
  type FleetInput,
  type ExecutionEnvironmentDescriptor,
  type Project as ContractProject,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
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

const decodeThreadRead = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
const decodeThreadSearch = Schema.decodeUnknownEffect(FleetThreadSearchResult);

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

const setup = (threadManagement?: ThreadManagement.ThreadManagementService["Service"]) => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
  const sent: Array<ThreadManagement.ThreadManagementSendInput> = [];
  const cloned: Array<FleetInput<"projects.clone">> = [];
  const updated: Array<Parameters<Project.ProjectService["Service"]["update"]>[0]> = [];
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
          update: (input) => {
            updated.push(input);
            return Effect.succeed({
              id: input.projectId,
              workspaceRoot: input.workspaceRoot,
            } as ContractProject);
          },
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
          ...threadManagement,
        }),
      ),
    ),
  );
  return { layer, dispatched, launched, sent, cloned, searched, updated };
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
          link: "<t3-thread://v2/studio/newer>",
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

it.effect("reads newest thread history by default and follows explicit cursors", () => {
  const database = SqlitePersistence.layerMemory;
  const instanceId = ProviderInstanceId.make("codex");
  const orchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "fleet-thread-read" },
    ProviderAdapterRegistry.layerFromAdapters([
      {
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
        openSession: () => Effect.die("History reads do not execute provider turns."),
      },
    ]),
    { databaseLayer: database, runEffectWorker: false },
  );
  const layer = ThreadManagement.layer.pipe(
    Layer.provideMerge(orchestrator),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
    Layer.provide(database),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(NodeServices.layer),
  );
  return Effect.gen(function* () {
    const commands = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* commands.dispatch({
      type: "thread.create",
      commandId: CommandId.make("fleet-read:create"),
      threadId,
      projectId: ProjectId.make("fleet-read"),
      title: "Read history",
      modelSelection: { instanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* commands.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("fleet-read:message"),
      threadId,
      messageId: MessageId.make("fleet-read:message"),
      text: "Seed history",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const run = (yield* threads.getThreadRecords(threadId, ["runs"])).runs[0];
    if (run === undefined) throw new Error("The history fixture has no run.");
    const now = yield* DateTime.now;
    yield* sink.write({
      events: ["oldest", "middle", "latest"].map((text, index) => ({
        id: EventId.make(`fleet-read:item:${index}`),
        type: "turn-item.updated",
        threadId,
        runId: run.id,
        providerInstanceId: instanceId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`fleet-read:item:${index}`),
          threadId,
          runId: run.id,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: index + 1,
          type: "reasoning",
          text,
          streaming: false,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      })),
    });
    const { layer: fleetLayer } = setup(threads);
    yield* Effect.gen(function* () {
      const fleet = yield* FleetService.FleetService;
      const read = (cursor: { afterPosition?: number; beforePosition?: number }) =>
        fleet
          .execute({
            actor,
            request: {
              op: "threads.read",
              input: { threadId, view: "activity", limit: 2, ...cursor },
            },
          })
          .pipe(Effect.flatMap(decodeThreadRead));
      const latest = yield* read({});
      expect(latest.items.map((item) => item.text)).toEqual(["middle", "latest"]);
      expect(latest.hasMore).toBe(false);
      const beforePosition = latest.earlierPosition;
      if (beforePosition === undefined || beforePosition === null)
        throw new Error("The latest page has no cursor for older history.");
      expect(beforePosition).toBe(latest.items[0]?.position);
      const first = yield* read({ afterPosition: -1 });
      expect(first.items.map((item) => item.text)).toEqual(["Seed history", "oldest"]);
      expect(first.hasMore).toBe(true);
      const older = yield* read({ beforePosition });
      expect(older.items).toEqual(first.items);
      expect(older.earlierPosition).toBeNull();
    }).pipe(Effect.provide(fleetLayer));
  }).pipe(Effect.provide(layer));
});

it.effect("repoints a project in the environment that runs the operation", () => {
  const { layer, updated } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const result = yield* fleet.execute({
      actor,
      request: {
        op: "projects.update",
        input: { projectId: ProjectId.make("e92c60f4"), workspaceRoot: "/home/nyx/dev/nebula" },
      },
    });
    expect(result).toMatchObject({ id: "e92c60f4", workspaceRoot: "/home/nyx/dev/nebula" });
    expect(updated).toMatchObject([
      { projectId: "e92c60f4", workspaceRoot: "/home/nyx/dev/nebula" },
    ]);
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
      currentThreadId: null,
      matches: [
        {
          threadId: "found",
          projectId: "a",
          title: "Found",
          source: "title",
          link: "[Found](t3-thread://v2/studio/found)",
        },
      ],
    });
    const local = yield* fleet.execute({
      actor: { ...actor, environmentId: EnvironmentId.make("studio") },
      request: { op: "threads.search", input: { query: "fleet" } },
    });
    const decoded = yield* decodeThreadSearch(local);
    expect(decoded.currentThreadId).toBe(actor.threadId);
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
    const jobError = yield* fleet
      .execute({
        actor,
        request: {
          op: "threads.launch",
          input: { scratch: true, title: "Worker", job: "Release audit" },
        },
      })
      .pipe(Effect.asVoid, Effect.flip);
    expect(jobError.code).toBe("invalid_request");
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
      job: "Release audit",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      message: "Work",
    };
    yield* fleet.execute({ actor, request: { op: "threads.launch", input } });
    yield* fleet.execute({ actor, request: { op: "threads.launch", input } });
    expect(launched[0]?.homeJob).toBe("Release audit");
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
    toolItems: [],
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
  // One run that answers several requests from one requester returns one result, for the latest.
  const nudges = [
    ...messages,
    { id: MessageId.make("a-again"), coordination: first },
    { id: MessageId.make("a-third"), coordination: first },
  ];
  expect(
    requestResults({ ...input, messages: nudges }).map((result) => result.requestMessageId),
  ).toEqual([MessageId.make("a-third"), MessageId.make("b")]);
});

it("skips the automatic result for a requester the run already messaged", () => {
  const remote = { environmentId: EnvironmentId.make("remote"), threadId: ThreadId.make("other") };
  const input = {
    messages: [
      { id: MessageId.make("a"), coordination: { kind: "request", requester: actor } },
    ] satisfies Parameters<typeof requestResults>[0]["messages"],
    sourceRunId: RunId.make("finished"),
    text: "The dependency is pinned.",
  };
  const send = (
    target: { readonly threadId: ThreadId; readonly environmentId?: EnvironmentId },
    status: "completed" | "failed" | "cancelled" = "completed",
    toolName = "mcp__t3-code__t3_thread_send",
  ) => ({
    type: "dynamic_tool" as const,
    toolName,
    status,
    ordinal: 1,
    input: { ...target, message: "Pinned to 4.2." },
  });
  const requesters = (toolItems: Parameters<typeof requestResults>[0]["toolItems"]) =>
    requestResults({ ...input, toolItems }).map((result) => result.requester);

  expect(requesters([send({ threadId: actor.threadId })])).toEqual([]);
  expect(requesters([send({ ...actor }, "completed", "t3-code.t3_thread_send")])).toEqual([]);
  expect(requesters([send({ threadId: ThreadId.make("elsewhere") })])).toEqual([actor]);
  expect(requesters([send({ threadId: actor.threadId }, "failed")])).toEqual([actor]);
  expect(requesters([send({ threadId: actor.threadId }, "cancelled")])).toEqual([actor]);
  expect(
    requesters([send({ threadId: actor.threadId }, "completed", "mcp__t3-code__t3_thread_read")]),
  ).toEqual([actor]);
  // A send that names another environment does not answer a requester here.
  expect(
    requesters([send({ threadId: actor.threadId, environmentId: remote.environmentId })]),
  ).toEqual([actor]);

  const twoRequesters = {
    ...input,
    messages: [
      ...input.messages,
      { id: MessageId.make("b"), coordination: { kind: "request", requester: remote } },
    ] satisfies Parameters<typeof requestResults>[0]["messages"],
  };
  expect(
    requestResults({ ...twoRequesters, toolItems: [send(remote)] }).map(
      (result) => result.requestMessageId,
    ),
  ).toEqual([MessageId.make("a")]);
});

it("still relays the final answer when tool work followed the send to the requester", () => {
  const remote = { environmentId: EnvironmentId.make("remote"), threadId: ThreadId.make("other") };
  const input = {
    messages: [
      { id: MessageId.make("a"), coordination: { kind: "request", requester: actor } },
      { id: MessageId.make("b"), coordination: { kind: "request", requester: remote } },
    ] satisfies Parameters<typeof requestResults>[0]["messages"],
    sourceRunId: RunId.make("finished"),
    text: "The dependency is pinned.",
  };
  const send = (target: typeof actor, ordinal: number) => ({
    type: "dynamic_tool" as const,
    toolName: "mcp__t3-code__t3_thread_send",
    status: "completed" as const,
    ordinal,
    input: { ...target, message: "Which version should I pin?" },
  });
  const command = (ordinal: number) => ({
    type: "command_execution" as const,
    status: "completed" as const,
    ordinal,
  });
  const requesters = (toolItems: Parameters<typeof requestResults>[0]["toolItems"]) =>
    requestResults({ ...input, toolItems }).map((result) => result.requester);

  // A mid-job question: the run kept working after the send, so its final report still goes out.
  expect(requesters([send(actor, 1), command(2)])).toEqual([actor, remote]);
  // The send is the run's last tool work: it was the final report.
  expect(requesters([command(1), send(actor, 2)])).toEqual([remote]);
  // Order comes from the projection ordinal, not from the array position.
  expect(requesters([send(actor, 2), command(1)])).toEqual([remote]);
  // Only the last send counts; an earlier send to another requester was a mid-job message.
  expect(requesters([send(remote, 1), send(actor, 2)])).toEqual([remote]);
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
      // A report to Home is delivered at once and expects no returned answer.
      yield* fleet.execute({
        actor: other,
        request: {
          op: "threads.send",
          input: { threadId: ThreadId.make("home:abc"), message: "Merged #17." },
        },
      });
      expect(sent[3]).toMatchObject({ mode: "auto" });
      expect(sent[3]?.coordination).toBeUndefined();
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
