import * as DocumentText from "../provider/DocumentText.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The fixture needs an independent HTTP listener.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  RpcScopeAuthorization,
  ScheduledTask,
  WS_METHODS,
  EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type SourceControlCloneRepositoryInput,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as TestClock from "effect/testing/TestClock";
import * as Duration from "effect/Duration";
import { HomeToolkit } from "../mcp/toolkits/home/tools.ts";
import * as HomeHandlers from "../mcp/toolkits/home/handlers.ts";
import * as DesktopMcpRelay from "../mcp/DesktopMcpRelay.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as FleetBroker from "../home/FleetBroker.ts";
import * as ServerConfig from "../config.ts";
import { notHomeLayer } from "../home/HomeTestkit.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RemoteDelegation from "./RemoteDelegation.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerLinkRequests from "./PeerLinkRequests.ts";
import {
  descriptorOf,
  layerHttpsTest,
  layerLinkingEnvironment,
  linkTo,
  servePeer,
} from "./PeerLinks.testkit.ts";

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");
const boxProject = ProjectId.make("project:box");
const boxThread = ThreadId.make("thread:box-auto");
const boxRun = RunId.make("run:box-auto");

/** What B's thread service was asked to do. */
interface Seen {
  readonly sends: ReadonlyArray<ThreadManagement.ThreadManagementSendInput>;
  readonly waits: ReadonlyArray<ThreadManagement.ThreadManagementWaitInput>;
  readonly launches: ReadonlyArray<ThreadLaunch.ThreadLaunchInput>;
  readonly projects: ReadonlyArray<ProjectService.ProjectCreateInput>;
  readonly clones: ReadonlyArray<SourceControlCloneRepositoryInput>;
  /** Commands dispatched and delegated-task stops, as `<type> <threadId>`. */
  readonly stops: ReadonlyArray<string>;
}
const nothingSeen: Seen = {
  sends: [],
  waits: [],
  launches: [],
  projects: [],
  clones: [],
  stops: [],
};

/** The box user's own thread, which no link started. */
const usersThread = ThreadId.make("thread:box-users-own");

/**
 * B's threads: one `auto` thread in `boxProject` that the laptop's link
 * started, whose run finishes on the third wait, and the box user's own.
 * Every send and wait is recorded.
 */
const boxThreads = (seen: Ref.Ref<Seen>, linkSession: Ref.Ref<string>) => {
  const base = { ...liveThreadShell(boxThread, { runtimeMode: "auto" }), projectId: boxProject };
  const linked = Ref.get(linkSession).pipe(
    Effect.map((sessionId) => ({ ...base, linkOrigin: { sessionId, label: "T3 Code · Laptop" } })),
  );
  const users = { ...liveThreadShell(usersThread, { runtimeMode: "auto" }), projectId: boxProject };
  const run = (status: OrchestrationV2Run["status"]) =>
    ({ id: boxRun, status }) as unknown as OrchestrationV2Run;
  const shellOf = (threadId: ThreadId): Effect.Effect<OrchestrationV2ThreadShell | null> =>
    threadId === boxThread ? linked : Effect.succeed(threadId === usersThread ? users : null);
  const projectionOf = (threadId: ThreadId) =>
    shellOf(threadId).pipe(
      Effect.map((thread) => ({ thread, runs: [run("running")], runtimeRequests: [] }) as never),
    );
  return Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: shellOf,
    getProjectThreadRecords: (input) => projectionOf(input.threadId),
    getThreadRecords: (threadId) => projectionOf(threadId),
    listProjectThreads: () => linked.pipe(Effect.map((shell) => [shell] as never)),
    sendToThread: (input) =>
      Ref.update(seen, (current) => ({ ...current, sends: [...current.sends, input] })).pipe(
        Effect.as({ run: run("running"), delivery: "started" } as never),
      ),
    dispatch: (command) =>
      Ref.update(seen, (current) => ({
        ...current,
        stops: [
          ...current.stops,
          `${command.type} ${"threadId" in command ? command.threadId : ""}`,
        ],
      })).pipe(
        // The stop asks the provider to interrupt the thread's running turn.
        Effect.as({
          sequence: 0,
          storedEvents: [
            {
              sequence: 1,
              commandId: command.commandId,
              event: {
                type: "turn-item.updated",
                runId: boxRun,
                payload: {
                  type: "run_interrupt_request",
                  providerTurnId: "provider-turn:box-auto",
                },
              },
            },
          ],
        } as never),
      ),
    stopDelegatedTasks: (input) =>
      Ref.update(seen, (current) => ({
        ...current,
        stops: [...current.stops, `delegated-tasks.stop ${input.threadId}`],
      })),
    waitForThread: (input) =>
      Ref.updateAndGet(seen, (current) => ({ ...current, waits: [...current.waits, input] })).pipe(
        Effect.map(({ waits }) => ({
          threadId: input.threadId,
          run: run(waits.length < 3 ? "running" : "completed"),
          timedOut: waits.length < 3,
        })),
      ),
  });
};

/** B launches whatever it is asked to, and records it. */
const boxLaunches = (seen: Ref.Ref<Seen>) =>
  Layer.mock(ThreadLaunch.ThreadLaunchService)({
    launch: (input) =>
      Ref.update(seen, (current) => ({ ...current, launches: [...current.launches, input] })).pipe(
        Effect.as({
          threadId: input.threadId,
          projection: {
            thread: {
              id: input.threadId,
              projectId: input.projectId,
              modelSelection: input.modelSelection,
              title: input.title,
            },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult),
      ),
  });

/** B clones and registers whatever it is asked to, and records it. */
const boxProjects = (seen: Ref.Ref<Seen>) =>
  Layer.merge(
    Layer.mock(ProjectService.ProjectService)({
      listPage: () => Effect.succeed({ projects: [], nextCursor: null }),
      getById: () => Effect.succeedNone,
      create: (input) =>
        Ref.update(seen, (current) => ({
          ...current,
          projects: [...current.projects, input],
        })).pipe(
          Effect.as({
            id: input.projectId,
            title: input.title,
            workspaceRoot: input.workspaceRoot,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-10-18T00:00:00.000Z",
            updatedAt: "2026-10-18T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
    Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
      cloneRepository: (input) =>
        Ref.update(seen, (current) => ({ ...current, clones: [...current.clones, input] })).pipe(
          Effect.as({
            cwd: input.destinationPath,
            remoteUrl: "https://github.com/pingdotgg/t3code.git",
            repository: null,
          }),
        ),
    }),
  );

/**
 * The orchestrator and project toolkits on B's real `/mcp`, behind its real
 * OAuth. `linkSession` is filled in once A links, so B's fixture thread reads
 * as one that link started.
 */
const decodeScheduledTask = Schema.decodeUnknownSync(ScheduledTask);

const boxTools = (seen: Ref.Ref<Seen>, linkSession: Ref.Ref<string>) =>
  Layer.mergeAll(
    McpHttpServer.layerOrchestratorToolkit,
    McpHttpServer.layerProjectRegistration,
    McpHttpServer.layerThreadToolkit,
  ).pipe(
    Layer.provide(notHomeLayer),
    Layer.provide(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(boxThreads(seen, linkSession)),
    Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
    Layer.provide(boxLaunches(seen)),
    Layer.provide(
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(boxProjects(seen)),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-forwarding-box-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    ),
    Layer.provide(
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([]),
      }),
    ),
    Layer.provide(
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({
        list: () =>
          Effect.succeed({
            tasks: [
              decodeScheduledTask({
                id: "webhook-fixture",
                title: "Webhook fixture",
                prompt: "Run fixture",
                enabled: true,
                schedule: { type: "webhook", signature: null },
                projectId: boxProject,
                threadId: null,
                workspaceStrategy: { type: "root" },
                modelSelection: { instanceId: "codex", model: "fixture" },
                runtimeMode: "approval-required",
                interactionMode: "default",
                createdBy: "user",
                creationSource: "web",
                createdAt: "2026-11-07T00:00:00.000Z",
                updatedAt: "2026-11-07T00:00:00.000Z",
                nextRunAt: null,
                lastRunAt: null,
                lastRunStatus: "never",
                lastRunError: null,
                runCount: 0,
                webhook: {
                  path: "/hooks/fixture",
                  url: "https://example.invalid/hooks/fixture",
                  hasSecret: false,
                },
              }),
            ],
          }),
      }),
    ),
    Layer.provide(Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({})),
    Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
    Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
        Layer.mock(PeerLinks.PeerLinks)({}),
      ),
    ),
  );

const serveBox = (seen: Ref.Ref<Seen>, linkSession: Ref.Ref<string>) =>
  servePeer(box, boxTools(seen, linkSession));

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "peer-forwarding-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "peer-forwarding-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/**
 * Environment A: its own orchestrator toolkit with forwarding, and a thread
 * caller whose modes the test picks. Its local threads never matter here.
 */
const laptopTools = (
  linking: Context.Context<PeerLinks.PeerLinks | import("./PeerMcpClient.ts").PeerMcpClient>,
  desktop: Layer.Layer<FleetBroker.FleetBroker> = Layer.mock(FleetBroker.FleetBroker)({
    reach: Effect.succeed({ hostConnected: false, mcpRelay: false, environments: [] }),
  }),
) =>
  Layer.mergeAll(
    McpHttpServer.layerOrchestratorToolkit,
    McpHttpServer.toolkitRegistration(HomeToolkit, HomeHandlers.layer),
    McpHttpServer.layerProjectRegistration,
    McpHttpServer.layerThreadToolkit,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        notHomeLayer,
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(laptop.environmentId),
          getDescriptor: Effect.succeed(laptop),
        }),
        desktop,
        DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
    Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
    Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
    Layer.provide(
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({})),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-forwarding-laptop-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(PeerForwarding.layer.pipe(Layer.provide(desktop))),
    Layer.provide(Layer.succeedContext(linking)),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(
            threadId === ThreadId.make("thread:laptop-from-desk")
              ? {
                  ...liveThreadShell(threadId, { runtimeMode: "full-access" }),
                  // Work another environment's link started on this laptop.
                  linkOrigin: { sessionId: "session:desk", label: "T3 Code · Desk" },
                }
              : {
                  ...liveThreadShell(
                    threadId,
                    threadId === ThreadId.make("thread:laptop-plan")
                      ? { runtimeMode: "full-access", interactionMode: "plan" }
                      : {
                          runtimeMode:
                            threadId === ThreadId.make("thread:laptop-supervised")
                              ? "approval-required"
                              : "full-access",
                        },
                  ),
                  projectId: ProjectId.make(`project:${threadId}`),
                  providerInstanceId: ProviderInstanceId.make(
                    threadId === ThreadId.make("thread:project-two-native") ? "native" : "codex",
                  ),
                },
          ),
        getProjectThreadRecords: ({ threadId }) =>
          Effect.succeed({
            thread: liveThreadShell(threadId, { runtimeMode: "full-access" }),
          } as never),
      }),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        ServerSettings.layerTest(),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
      ),
    ),
  );

const makeLaptopWithDesktop = (desktop?: Layer.Layer<FleetBroker.FleetBroker>) =>
  Effect.gen(function* () {
    const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
    const here = yield* Layer.build(
      laptopTools(linking, desktop).pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.fresh,
      ),
    );
    const server = Context.get(here, McpServer.McpServer);
    const scopeOf = (
      caller: string,
      capabilities: ReadonlySet<McpInvocationContext.McpCapability> = new Set(["orchestration"]),
    ): McpInvocationContext.McpInvocationScope => ({
      environmentId: laptop.environmentId,
      requestNamespace: `provider-session:${caller}`,
      thread: {
        threadId: ThreadId.make(caller),
        providerSessionId: `provider-session:${caller}`,
        providerInstanceId: ProviderInstanceId.make(
          caller === "thread:project-two-native" ? "native" : "codex",
        ),
      },
      client: undefined,
      capabilities,
      issuedAt: 1,
    });
    const call = (
      caller: string,
      name: string,
      args: Record<string, unknown>,
      capabilities?: ReadonlySet<McpInvocationContext.McpCapability>,
    ) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            scopeOf(caller, capabilities),
          ),
          Effect.provideService(McpSchema.McpServerClient, mcpClient),
        );
    const callClient = (
      name: string,
      args: Record<string, unknown>,
      access: "read-only" | "full-access",
    ) =>
      server.callTool({ name, arguments: args }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          environmentId: laptop.environmentId,
          requestNamespace: "client:external",
          thread: undefined,
          client: { sessionId: "external", label: "External", access },
          capabilities: new Set<McpInvocationContext.McpCapability>(["orchestration"]),
          issuedAt: 1,
        }),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
    return { links: Context.get(linking, PeerLinks.PeerLinks), call, callClient };
  });

const makeLaptop = makeLaptopWithDesktop();

const failureOf = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

it.effect("an agent here works on a linked environment's threads within its own modes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const b = yield* serveBox(seen, linkSession);
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "auto");
      yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);

      const listed = yield* a.call("thread:laptop-full", "t3_environment_links", {});
      expect(listed.structuredContent).toMatchObject({
        environmentId: laptop.environmentId,
        links: [
          { environmentId: box.environmentId, label: "Box", status: "reachable", access: "auto" },
        ],
      });

      const threads = yield* a.call("thread:laptop-full", "t3_thread_list", {
        environmentId: box.environmentId,
        projectId: boxProject,
      });
      expect(threads.isError).toBe(false);
      expect(threads.structuredContent).toMatchObject({
        projectId: boxProject,
        threads: [{ threadId: boxThread, runtimeMode: "auto" }],
      });

      // A full-access agent here is held to the link's `auto` there, which
      // the box's `auto` thread is within.
      const sent = yield* a.call("thread:laptop-full", "t3_thread_send", {
        environmentId: box.environmentId,
        threadId: boxThread,
        message: "Carry on there.",
        clientRequestId: "send-1",
      });
      expect(sent.isError).toBe(false);
      expect(sent.structuredContent).toMatchObject({ threadId: boxThread, delivery: "started" });

      // A plan-mode agent here may not steer that thread there: the box
      // refuses it, because the call carries the agent's own modes.
      const planned = yield* a.call("thread:laptop-plan", "t3_thread_send", {
        environmentId: box.environmentId,
        threadId: boxThread,
        message: "Change course.",
      });
      expect(failureOf(planned)).toMatchObject({ code: "interaction_mode_escalation_denied" });
      expect((yield* Ref.get(seen)).sends).toHaveLength(1);

      // stop=true stops the thread there as its Stop button does: the whole
      // thread and the tasks it delegated, not just the running turn.
      const stopped = yield* a.call("thread:laptop-full", "t3_thread_interrupt", {
        environmentId: box.environmentId,
        threadId: boxThread,
        stop: true,
        clientRequestId: "stop-1",
      });
      expect(stopped.structuredContent).toMatchObject({
        threadId: boxThread,
        runId: boxRun,
        status: "interrupt_requested",
      });
      expect((yield* Ref.get(seen)).stops).toEqual([
        `thread.stop ${boxThread}`,
        `delegated-tasks.stop ${boxThread}`,
      ]);
    }),
  ).pipe(Effect.provide(layerHttpsTest)),
);

it.effect("keeps a forwarded wait short and its retries scoped to the caller", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const b = yield* serveBox(seen, linkSession);
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "auto");
      yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);

      const waited = yield* a.call("thread:laptop-full", "t3_thread_wait", {
        environmentId: box.environmentId,
        threadId: boxThread,
        timeoutMs: 600_000,
      });
      expect(waited.structuredContent).toEqual({
        threadId: boxThread,
        runId: boxRun,
        status: "completed",
        timedOut: false,
      });
      // Three pieces of at most 50 s each, the later ones pinned to the run
      // the first one found.
      expect(
        (yield* Ref.get(seen)).waits.map(({ timeoutMs, runId }) => [timeoutMs, runId]),
      ).toEqual([
        [PeerForwarding.FORWARDED_WAIT_CHUNK_MS, undefined],
        [PeerForwarding.FORWARDED_WAIT_CHUNK_MS, boxRun],
        [PeerForwarding.FORWARDED_WAIT_CHUNK_MS, boxRun],
      ]);

      const send = (caller: string, clientRequestId: string) =>
        a.call(caller, "t3_thread_send", {
          environmentId: box.environmentId,
          threadId: boxThread,
          message: "Once.",
          clientRequestId,
        });
      yield* send("thread:laptop-full", "same-key");
      yield* send("thread:laptop-full", "same-key");
      yield* send("thread:laptop-other", "same-key");
      const [first, retried, other] = (yield* Ref.get(seen)).sends.map((input) => input.commandId);
      // The box sees every caller here as the one link, so the key is scoped
      // to its caller before it leaves: a retry matches, another agent's same
      // key does not.
      expect(retried).toBe(first);
      expect(other).not.toBe(first);
      expect(first).not.toContain("same-key");
    }),
  ).pipe(Effect.provide(layerHttpsTest)),
);

it.effect("launches in a linked environment with the caller's modes, retry-safe", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const b = yield* serveBox(seen, linkSession);
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "full-access");
      yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);
      const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
      const launch = (caller: string, args: Record<string, unknown> = {}) =>
        a.call(caller, "t3_thread_launch", {
          environmentId: box.environmentId,
          projectId: boxProject,
          title: "Run the suite there",
          modelSelection: codex,
          message: "Run the suite.",
          clientRequestId: "launch-1",
          ...args,
        });

      const first = yield* launch("thread:laptop-plan");
      expect(first.isError).toBe(false);
      expect(first.structuredContent).toMatchObject({
        projectId: boxProject,
        modelSelection: codex,
      });
      const retried = yield* launch("thread:laptop-plan");
      const [launched, relaunched] = (yield* Ref.get(seen)).launches;
      // The thread there runs with the caller's own modes here, below the
      // link's full access, and a retry asks for the same thread.
      expect(launched).toMatchObject({ runtimeMode: "full-access", interactionMode: "plan" });
      expect(relaunched?.threadId).toBe(launched?.threadId);
      expect(retried.structuredContent).toEqual(first.structuredContent);

      // An escalation past the caller's own modes is refused here.
      const escalated = yield* launch("thread:laptop-plan", { interactionMode: "default" });
      expect(failureOf(escalated)).toMatchObject({ code: "interaction_mode_escalation_denied" });
      // A pending upload lives here, so it cannot go along.
      yield* Ref.set(b.bearers, []);
      const withUpload = yield* launch("thread:laptop-full", {
        clientRequestId: "launch-2",
        attachments: [
          { type: "image", id: "upload-1", name: "a.png", mimeType: "image/png", sizeBytes: 1 },
        ],
      });
      expect(failureOf(withUpload)).toMatchObject({ code: "invalid_request" });
      expect(yield* Ref.get(b.bearers)).toEqual([]);
      expect((yield* Ref.get(seen)).launches).toHaveLength(2);
    }),
  ).pipe(Effect.provide(layerHttpsTest)),
);

it.effect("brings a repository to a linked environment, only through full access", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const b = yield* serveBox(seen, yield* Ref.make(""));
      const a = yield* makeLaptop;
      const clone = { repository: "pingdotgg/t3code", destinationPath: "/home/box/t3code" };
      const register = { title: "t3code", workspaceRoot: "/home/box/t3code" };

      yield* linkTo(a.links, b, "full-access");
      const cloned = yield* a.call("thread:laptop-full", "t3_project_clone", {
        environmentId: box.environmentId,
        ...clone,
      });
      expect(cloned.structuredContent).toMatchObject({ cwd: clone.destinationPath });
      const created = yield* a.call("thread:laptop-full", "t3_project_create", {
        environmentId: box.environmentId,
        ...register,
      });
      expect(created.structuredContent).toMatchObject(register);
      expect((yield* Ref.get(seen)).clones).toEqual([clone]);
      expect((yield* Ref.get(seen)).projects).toMatchObject([register]);

      // A plan-mode agent here may not, and nothing leaves.
      yield* Ref.set(b.bearers, []);
      const planned = yield* a.call("thread:laptop-plan", "t3_project_create", {
        environmentId: box.environmentId,
        ...register,
      });
      expect(failureOf(planned)).toMatchObject({ code: "capability_denied" });
      expect(yield* Ref.get(b.bearers)).toEqual([]);

      // Nor may a full-access agent through a link with less: the box holds it.
      yield* linkTo(a.links, b, "auto");
      for (const [name, args] of [
        ["t3_project_clone", clone],
        ["t3_project_create", register],
      ] as const) {
        const refused = yield* a.call("thread:laptop-full", name, {
          environmentId: box.environmentId,
          ...args,
        });
        expect(failureOf(refused), name).toMatchObject({ code: "capability_denied" });
      }
      expect((yield* Ref.get(seen)).clones).toHaveLength(1);
      expect((yield* Ref.get(seen)).projects).toHaveLength(1);
    }),
  ).pipe(Effect.provide(layerHttpsTest)),
);

it.effect("runs any tool that takes a linked environment there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const b = yield* serveBox(seen, linkSession);
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "auto");
      yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);

      const there = yield* a.call("thread:laptop-full", "t3_thread_configure", {
        environmentId: box.environmentId,
        threadId: boxThread,
      });
      expect(there.structuredContent).toMatchObject({ threadId: boxThread, runtimeMode: "auto" });
      const archived = yield* a.call("thread:laptop-full", "t3_thread_organize", {
        environmentId: box.environmentId,
        threadId: boxThread,
        action: "archive",
      });
      expect(archived.isError).toBe(false);
      expect((yield* Ref.get(seen)).stops).toEqual([`thread.archive ${boxThread}`]);

      // This environment's own id keeps the call here.
      const own = yield* a.call("thread:laptop-full", "t3_thread_configure", {
        environmentId: laptop.environmentId,
      });
      expect(own.structuredContent).toMatchObject({
        threadId: "thread:laptop-full",
        runtimeMode: "full-access",
      });
    }),
  ).pipe(Effect.provide(layerHttpsTest)),
);

it.effect("refuses what a linked environment cannot take before anything leaves", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const linkSession = yield* Ref.make("");
      const b = yield* serveBox(seen, linkSession);
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "auto");
      yield* Ref.set(linkSession, (yield* b.linkedSessions)[0]!.sessionId);
      yield* Ref.set(b.bearers, []);

      const unknown = yield* a.call("thread:laptop-full", "t3_thread_read", {
        environmentId: EnvironmentId.make("environment-elsewhere"),
        threadId: boxThread,
      });
      expect(failureOf(unknown)).toMatchObject({ code: "invalid_request" });
      expect(yield* Ref.get(b.bearers)).toEqual([]);

      // The box sees only the link's credential, so one that may not control
      // threads here may not reach them there either.
      const previewOnly = new Set<McpInvocationContext.McpCapability>(["preview"]);
      for (const [name, args] of [
        ["t3_environment_links", {}],
        ["t3_project_list", { environmentId: box.environmentId }],
        ["t3_thread_list", { environmentId: box.environmentId, projectId: boxProject }],
        ["t3_thread_read", { environmentId: box.environmentId, threadId: boxThread }],
        ["t3_thread_wait", { environmentId: box.environmentId, threadId: boxThread }],
        [
          "t3_thread_send",
          { environmentId: box.environmentId, threadId: boxThread, message: "Carry on there." },
        ],
        [
          "t3_thread_organize",
          { environmentId: box.environmentId, threadId: boxThread, action: "archive" },
        ],
        [
          "t3_thread_launch",
          {
            environmentId: box.environmentId,
            projectId: boxProject,
            title: "Start there",
            modelSelection: { instanceId: "codex", model: "gpt-5" },
            message: "Start there.",
          },
        ],
      ] as const) {
        const refused = yield* a.call("thread:laptop-full", name, args, previewOnly);
        expect(failureOf(refused), name).toMatchObject({ code: "capability_denied" });
      }
      expect(yield* Ref.get(b.bearers)).toEqual([]);

      // Work a desk's link started here never uses this laptop's links: the
      // box would see the laptop, not the desk, so its fence could not hold.
      for (const [name, args] of [
        ["t3_thread_read", { environmentId: box.environmentId, threadId: boxThread }],
        [
          "t3_thread_send",
          { environmentId: box.environmentId, threadId: boxThread, message: "From the desk." },
        ],
        [
          "t3_thread_launch",
          { environmentId: box.environmentId, projectId: boxProject, title: "x" },
        ],
      ] as const) {
        const relayed = yield* a.call("thread:laptop-from-desk", name, args);
        expect(failureOf(relayed), name).toMatchObject({ code: "capability_denied" });
      }
      expect(yield* Ref.get(b.bearers)).toEqual([]);
    }),
  ).pipe(Effect.provide(layerHttpsTest)),
);

it.effect("an external client reaches a linked environment and respects its own access", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen = yield* Ref.make<Seen>(nothingSeen);
      const session = yield* Ref.make("");
      const boxServer = yield* serveBox(seen, session);
      const laptopServer = yield* makeLaptop;
      yield* linkTo(laptopServer.links, boxServer, "auto");
      yield* Ref.set(session, (yield* boxServer.linkedSessions)[0]!.sessionId);
      const listed = yield* laptopServer.callClient(
        "t3_thread_list",
        { environmentId: box.environmentId, projectId: boxProject },
        "read-only",
      );
      expect(listed.isError).toBe(false);
      expect(listed.structuredContent).toMatchObject({ threads: [{ threadId: boxThread }] });
      const denied = yield* laptopServer.callClient(
        "t3_thread_send",
        {
          environmentId: box.environmentId,
          threadId: boxThread,
          message: "No",
          clientRequestId: "external",
        },
        "read-only",
      );
      expect(failureOf(denied)?.code).toBe("capability_denied");
      const sent = yield* laptopServer.callClient(
        "t3_thread_send",
        {
          environmentId: box.environmentId,
          threadId: boxThread,
          message: "Continue",
          clientRequestId: "external",
        },
        "full-access",
      );
      expect(sent.isError).toBe(false);
      expect((yield* Ref.get(seen)).sends).toHaveLength(1);
    }),
  ).pipe(Effect.provide(layerHttpsTest)),
);

const decodeRegistration = Schema.decodeUnknownEffect(Schema.Struct({ client_id: Schema.String }));
const decodeDecision = Schema.decodeUnknownEffect(Schema.Struct({ redirectTo: Schema.String }));
const decodeToken = Schema.decodeUnknownEffect(Schema.Struct({ access_token: Schema.String }));
const decodeToolResponse = Schema.decodeUnknownEffect(
  Schema.Struct({ result: McpSchema.CallToolResult }),
);
it.live(
  "authenticates an external OAuth client over HTTP and forwards its access to an HTTPS peer",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen = yield* Ref.make<Seen>(nothingSeen);
        const session = yield* Ref.make("");
        const boxServer = yield* serveBox(seen, session);
        const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
        yield* linkTo(Context.get(linking, PeerLinks.PeerLinks), boxServer, "auto");
        yield* Ref.set(session, (yield* boxServer.linkedSessions)[0]!.sessionId);
        const http = yield* NodeHttpServer.layer(() => NodeHttp.createServer(), {
          port: 0,
          host: "127.0.0.1",
        }).pipe(Layer.build);
        const laptopServer = yield* servePeer(laptop, laptopTools(linking), "http").pipe(
          Effect.provideContext(http),
        );
        const request = (path: string, init?: RequestInit) =>
          // @effect-diagnostics-next-line globalFetchInEffect:off - This fixture acts as an external HTTP client.
          Effect.promise(() => fetch(`${laptopServer.url}${path}`, init));
        const json = (response: Response) => Effect.promise(() => response.json());
        const post = (path: string, body: unknown) =>
          request(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
        const registration = yield* post("/oauth/mcp/register", {
          client_name: "External client",
          redirect_uris: ["http://localhost:51234/callback"],
          grant_types: ["authorization_code"],
          token_endpoint_auth_method: "none",
        });
        expect(registration.status).toBe(201);
        const { client_id } = yield* decodeRegistration(yield* json(registration));
        const verifier = "a".repeat(43) + "-verifier-for-tests";
        const params = {
          response_type: "code",
          client_id,
          redirect_uri: "http://localhost:51234/callback",
          code_challenge: "DeB41nTVkPwpbbYecrnqtVq7VXLezustdHAK4SWt13c",
          code_challenge_method: "S256",
          state: "state-1",
          resource: `${laptopServer.url}/mcp`,
        };
        const tokenFor = (access: "read-only" | "auto") =>
          Effect.gen(function* () {
            const pairing = yield* laptopServer.auth.issuePairingCredential();
            const decision = yield* post("/oauth/mcp/decision", {
              authorization: params,
              decision: { _tag: "pairing-code", access, code: pairing.credential },
            });
            expect(decision.status).toBe(200);
            const { redirectTo } = yield* decodeDecision(yield* json(decision));
            const code = new URL(redirectTo).searchParams.get("code");
            expect(code).toBeTruthy();
            const response = yield* request("/oauth/mcp/token", {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "authorization_code",
                code: code!,
                redirect_uri: params.redirect_uri,
                client_id,
                code_verifier: verifier,
                resource: params.resource,
              }),
            });
            expect(response.status).toBe(200);
            const token = yield* decodeToken(yield* json(response));
            return token.access_token;
          });
        const connect = (token: string) =>
          Effect.gen(function* () {
            const headers = {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            };
            const initialize = yield* request("/mcp", {
              method: "POST",
              headers,
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                  protocolVersion: "2025-06-18",
                  capabilities: {},
                  clientInfo: { name: "external", version: "1" },
                },
              }),
            });
            expect(initialize.status).toBe(200);
            const sessionId = initialize.headers.get("mcp-session-id");
            expect(sessionId).toBeTruthy();
            return (name: string, args: Record<string, unknown>) =>
              Effect.gen(function* () {
                const response = yield* request("/mcp", {
                  method: "POST",
                  headers: {
                    ...headers,
                    "mcp-session-id": sessionId!,
                    "mcp-protocol-version": "2025-06-18",
                  },
                  body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 2,
                    method: "tools/call",
                    params: { name, arguments: args },
                  }),
                });
                expect(response.status).toBe(200);
                const payload = yield* json(response);
                const decoded = yield* decodeToolResponse(payload);
                return decoded.result;
              });
          });
        const reader = yield* connect(yield* tokenFor("read-only"));
        const listed = yield* reader("t3_thread_list", {
          environmentId: box.environmentId,
          projectId: boxProject,
        });
        expect(listed.structuredContent).toMatchObject({ threads: [{ threadId: boxThread }] });
        const args = {
          environmentId: box.environmentId,
          threadId: boxThread,
          message: "Continue",
          clientRequestId: "external",
        };
        const denied = yield* reader("t3_thread_send", args);
        expect(failureOf(denied)?.code).toBe("capability_denied");
        expect((yield* Ref.get(seen)).sends).toHaveLength(0);
        const operator = yield* connect(yield* tokenFor("auto"));
        const sent = yield* operator("t3_thread_send", args);
        expect(sent.isError).toBe(false);
        expect((yield* Ref.get(seen)).sends).toHaveLength(1);
      }),
    ).pipe(Effect.provide(layerHttpsTest)),
);

const desktopFixture = Effect.gen(function* () {
  const desktop = yield* FleetBroker.layer.pipe(Layer.provide(NodeCrypto.layer), Layer.build);
  const broker = Context.get(desktop, FleetBroker.FleetBroker);
  const seen = yield* Ref.make<Seen>(nothingSeen);
  const linkSession = yield* Ref.make("");
  const remote = yield* McpHttpServer.layerDesktopRelay(boxTools(seen, linkSession)).pipe(
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(box.environmentId),
        getDescriptor: Effect.succeed(box),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.fresh,
    Layer.build,
  );
  const destination = Context.get(remote, DesktopMcpRelay.DesktopMcpRelay);
  const calls = yield* Ref.make(0);
  const failure = yield* Ref.make<"revoked" | "expired" | null>(null);
  const register = (
    environments: ReadonlyArray<{
      environmentId: EnvironmentId;
      label: string;
      connected: boolean;
    }>,
  ) =>
    broker.connect({ clientId: "desktop", mcpRelay: true, environments }).pipe(
      Effect.flatMap((stream) =>
        Stream.runForEach(stream, (request) =>
          Effect.gen(function* () {
            yield* Ref.update(calls, (count) => count + 1);
            const denied = yield* Ref.get(failure);
            if (denied !== null)
              return yield* broker.respond({
                requestId: request.requestId,
                failure: new OrchestratorMcpFailure({
                  code: "capability_denied",
                  message: `Desktop session ${denied}.`,
                }),
              });
            if (!("mcp" in request.invoke))
              return yield* Effect.die("Ordinary callers must not use Home's operations.");
            const result = yield* destination
              .invoke(request.invoke, "desktop-session")
              .pipe(Effect.result);
            yield* broker.respond(
              result._tag === "Success"
                ? { requestId: request.requestId, result: result.success }
                : { requestId: request.requestId, failure: result.failure },
            );
          }),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
  const connection = { environmentId: box.environmentId, label: "Box", connected: true };
  const host = yield* register([connection]);
  const a = yield* makeLaptopWithDesktop(Layer.succeedContext(desktop));
  return { ...a, broker, destination, seen, calls, failure, register, connection, host };
});

it.effect(
  "ordinary sessions discover and use one existing desktop connection without peer pairing",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const a = yield* desktopFixture;
        for (const caller of ["thread:project-one-codex", "thread:project-two-native"]) {
          const listed = yield* a.call(caller, "t3_environment_links", {});
          expect(listed.structuredContent).toMatchObject({
            links: [
              {
                environmentId: box.environmentId,
                source: "desktop",
                access: null,
                expiresAt: null,
              },
            ],
          });
          const projects = yield* a.call(caller, "t3_project_list", {
            environmentId: box.environmentId,
          });
          expect(projects.structuredContent).toMatchObject({ projects: [], nextCursor: null });
          const providers = yield* a.call(caller, "orchestrator_capabilities", {
            environmentId: box.environmentId,
          });
          expect(providers.structuredContent).toMatchObject({
            parentThreadId: null,
            providers: [],
          });
          const sent = yield* a.call(caller, "t3_thread_send", {
            environmentId: box.environmentId,
            threadId: boxThread,
            message: "Continue",
            clientRequestId: "same-key",
          });
          expect(failureOf(sent)).toBeUndefined();
        }
        expect(yield* a.links.list).toEqual([]);
        const sends = (yield* Ref.get(a.seen)).sends;
        expect(sends).toHaveLength(2);
        expect(sends[0]?.commandId).not.toEqual(sends[1]?.commandId);
        expect(yield* Ref.get(a.calls)).toBe(6);
        const delegatedFrom = {
          environmentId: laptop.environmentId,
          threadId: ThreadId.make("thread:project-one-codex"),
          title: "Parent fixture",
        };
        const launched = yield* a.call("thread:project-one-codex", "t3_thread_launch", {
          environmentId: box.environmentId,
          projectId: boxProject,
          title: "Child fixture",
          modelSelection: { instanceId: "codex", model: "gpt-5" },
          delegatedFrom,
        });
        expect(launched.isError).toBe(false);
        expect((yield* Ref.get(a.seen)).launches[0]).toMatchObject({
          delegatedFrom,
          linkOrigin: {
            sessionId: "desktop-session",
            label: "Desktop connection",
            access: "full-access",
          },
        });
      }),
    ),
);

it.effect("desktop calls retain ordinary caller permissions at both route boundaries", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* desktopFixture;
      const homeOnly = yield* a.call("thread:laptop-full", "t3_thread_watch", {
        action: "watch_all",
      });
      expect(failureOf(homeOnly)?.code).toBe("capability_denied");
      const args = { environmentId: box.environmentId, threadId: boxThread, message: "Continue" };
      const readonly = yield* a.callClient("t3_thread_send", args, "read-only");
      expect(failureOf(readonly)?.code).toBe("capability_denied");
      const supervised = yield* a.call("thread:laptop-supervised", "t3_thread_send", args);
      expect(failureOf(supervised)?.code).toBe("runtime_mode_escalation_denied");
      const planned = yield* a.call("thread:laptop-plan", "t3_thread_send", args);
      expect(failureOf(planned)?.code).toBe("interaction_mode_escalation_denied");
      const unscoped = yield* a.call(
        "thread:laptop-full",
        "t3_thread_send",
        args,
        new Set(["preview"]),
      );
      expect(failureOf(unscoped)?.code).toBe("capability_denied");
      const linked = yield* a.call("thread:laptop-from-desk", "t3_thread_send", args);
      expect(failureOf(linked)?.code).toBe("capability_denied");
      expect((yield* Ref.get(a.seen)).sends).toEqual([]);
      const read = yield* a.callClient(
        "t3_thread_list",
        { environmentId: box.environmentId, projectId: boxProject },
        "read-only",
      );
      expect(read.isError).toBe(false);
      for (const [limits, code] of [
        [
          { readOnly: true, runtimeMode: "full-access", interactionMode: "default" },
          "capability_denied",
        ],
        [
          { readOnly: false, runtimeMode: "approval-required", interactionMode: "default" },
          "runtime_mode_escalation_denied",
        ],
        [
          { readOnly: false, runtimeMode: "full-access", interactionMode: "plan" },
          "interaction_mode_escalation_denied",
        ],
      ] as const) {
        const denied = yield* a.destination
          .invoke(
            {
              mcp: {
                ...limits,
                namespace: "direct",
                tool: "t3_thread_send",
                arguments: { threadId: boxThread, message: "Continue" },
              },
            },
            "desktop-session",
          )
          .pipe(Effect.exit);
        expect(Exit.isFailure(denied) && Cause.squash(denied.cause)).toMatchObject({ code });
      }
      for (const tool of ["t3_environment_list", "t3_thread_watch", "t3_environment_links"]) {
        const denied = yield* a.destination
          .invoke(
            {
              mcp: {
                tool,
                arguments: {},
                namespace: "external",
                readOnly: false,
                runtimeMode: "full-access",
                interactionMode: "default",
              },
            },
            "desktop-session",
          )
          .pipe(Effect.exit);
        expect(Exit.isFailure(denied) && Cause.squash(denied.cause)).toMatchObject({
          code: "capability_denied",
        });
      }
      for (const [scopes, readOnly, exposesTrigger] of [
        [[AuthOrchestrationReadScope], false, false],
        [[AuthOrchestrationReadScope], true, false],
        [[AuthOrchestrationReadScope, AuthOrchestrationOperateScope], true, false],
        [[AuthOrchestrationReadScope, AuthOrchestrationOperateScope], false, true],
      ] as const) {
        const input = {
          mcp: {
            tool: "list_scheduled_tasks",
            arguments: {},
            namespace: "ordinary-caller",
            readOnly,
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        } as const;
        const authorize = yield* RpcScopeAuthorization.pipe(
          Effect.provide(RpcAuthorization.layer(scopes)),
        );
        const result = yield* authorize(a.destination.invoke(input, "read-destination"), {
          rpc: { _tag: WS_METHODS.fleetInvoke },
          payload: input,
        });
        expect(result).toMatchObject({ tasks: [{ scheduledTaskId: "webhook-fixture" }] });
        expect(JSON.stringify(result).includes("webhookUrl")).toBe(exposesTrigger);
      }
    }),
  ),
);

it.effect("desktop routing checks the live connection on every call", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* desktopFixture;
      const args = { environmentId: box.environmentId, projectId: boxProject };
      expect((yield* a.call("thread:laptop-full", "t3_thread_list", args)).isError).toBe(false);
      for (const reason of ["revoked", "expired"] as const) {
        yield* Ref.set(a.failure, reason);
        expect(failureOf(yield* a.call("thread:laptop-full", "t3_thread_list", args))?.code).toBe(
          "capability_denied",
        );
      }
      yield* Ref.set(a.failure, null);
      yield* a.register([{ ...a.connection, connected: false }]);
      expect(failureOf(yield* a.call("thread:laptop-full", "t3_thread_list", args))?.code).toBe(
        "environment_unavailable",
      );
      yield* a.register([]);
      expect(failureOf(yield* a.call("thread:laptop-full", "t3_thread_list", args))?.code).toBe(
        "invalid_request",
      );
      const active = yield* a.register([a.connection]);
      yield* Fiber.interrupt(active);
      expect(failureOf(yield* a.call("thread:laptop-full", "t3_thread_list", args))?.code).toBe(
        "invalid_request",
      );
      const listed = yield* a.call("thread:laptop-full", "t3_environment_links", {});
      expect(listed.structuredContent).toMatchObject({ links: [] });
    }),
  ),
);

it.effect(
  "stored peer grants retain priority over desktop connections after revocation and expiry",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const a = yield* desktopFixture;
        const b = yield* serveBox(yield* Ref.make<Seen>(nothingSeen), yield* Ref.make(""));
        yield* linkTo(a.links, b, "auto");
        const args = { environmentId: box.environmentId, projectId: boxProject };
        expect((yield* a.call("thread:laptop-full", "t3_thread_list", args)).isError).toBe(false);
        const [session] = yield* b.linkedSessions;
        expect(session).toBeDefined();
        yield* b.auth.revokeSession(session!.sessionId);
        expect(failureOf(yield* a.call("thread:laptop-full", "t3_thread_list", args))?.code).toBe(
          "capability_denied",
        );
        yield* linkTo(a.links, b, "auto");
        yield* TestClock.adjust(Duration.days(31));
        expect(failureOf(yield* a.call("thread:laptop-full", "t3_thread_list", args))?.code).toBe(
          "capability_denied",
        );
        expect(yield* Ref.get(a.calls)).toBe(0);
      }),
    ).pipe(Effect.provide(layerHttpsTest)),
);
