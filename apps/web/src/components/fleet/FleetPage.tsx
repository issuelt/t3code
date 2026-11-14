import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { FleetChief, FleetJobGroup } from "@t3tools/client-runtime/state/fleetBoard";
import {
  isOpenOrPendingPullRequest,
  visibleThreadPullRequests,
} from "@t3tools/client-runtime/thread-pull-requests";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  type EnvironmentId,
  resolveEnvironmentMachineKind,
  type ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { BriefcaseIcon, InboxIcon } from "lucide-react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { providerModelLabel } from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { fleetBoardAtom } from "../../state/fleet";
import { orchestrationEnvironment } from "../../state/orchestration";
import { providerEntriesByEnvironmentAtom } from "../../state/providerEntries";
import { useEnvironmentQuery } from "../../state/query";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ListGroupHeader } from "../ListGroupHeader";
import { PullRequestRowLines } from "../pullRequest/PullRequestListRow";
import { PAGE_ROW_BUTTON_CLASS } from "../pullRequest/PullRequestRow";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
} from "../Sidebar.logic";
import { SIDEBAR_TOP_STATUS, sidebarTopStatusKind } from "../sidebar/sidebarTopStatus";
import { Badge } from "../ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

function sortedThreadIdsByEnvironment(board: ReadonlyArray<FleetJobGroup>) {
  const byEnvironment = new Map<EnvironmentId, Array<ThreadId>>();
  for (const { chiefs } of board) {
    for (const { shell } of chiefs) {
      const ids = byEnvironment.get(shell.environmentId);
      if (ids === undefined) byEnvironment.set(shell.environmentId, [shell.id]);
      else ids.push(shell.id);
    }
  }
  for (const ids of byEnvironment.values()) ids.sort();
  return byEnvironment;
}

function FleetReportLine({
  chief,
  threadIds,
}: {
  chief: FleetChief;
  threadIds: ReadonlyArray<ThreadId>;
}) {
  const results = useEnvironmentQuery(
    orchestrationEnvironment.latestRunResults({
      environmentId: chief.shell.environmentId,
      input: { threadIds },
    }),
  );
  if (results.isSuccess && results.data === null) {
    return (
      <>
        <span aria-hidden>·</span>
        <span className="shrink-0">Needs a newer server</span>
      </>
    );
  }
  const lastLine = results.data?.[chief.shell.id];
  if (lastLine === undefined) return null;
  return (
    <>
      <span aria-hidden>·</span>
      <span className="min-w-0 truncate text-foreground/80">{lastLine}</span>
    </>
  );
}

function FleetPullRequests({ shell }: { shell: EnvironmentThreadShell }) {
  const open = visibleThreadPullRequests(shell.pullRequests).filter(isOpenOrPendingPullRequest);
  if (open.length === 0) return null;
  return open.map((link) => {
    const presentation =
      link.snapshot === null
        ? null
        : resolvePullRequestState({ state: link.snapshot.state, isDraft: link.snapshot.isDraft });
    const Icon = presentation?.Icon ?? PullRequestGlyph.pullRequest;
    return (
      <span
        key={`${link.host}/${link.repository}#${link.number}`}
        className="inline-flex items-center gap-0.5 font-mono tabular-nums text-muted-foreground"
        aria-label={`${link.repository} #${link.number}${presentation === null ? ", status pending" : `, ${presentation.label}`}`}
      >
        <Icon
          aria-hidden
          className={cn("size-3", presentation?.toneClassName ?? "text-muted-foreground")}
        />
        #{link.number}
      </span>
    );
  });
}

function FleetChiefRow({
  chief,
  threadIds,
  environmentLabel,
  machine,
  modelLabel,
  onOpen,
}: {
  chief: FleetChief;
  threadIds: ReadonlyArray<ThreadId>;
  environmentLabel: string;
  machine: ReturnType<typeof resolveEnvironmentMachineKind>;
  modelLabel: string;
  onOpen: (chief: FleetChief) => void;
}) {
  const { shell, environmentConnected } = chief;
  const localLastVisitedAt = useUiStateStore(
    (state) =>
      state.threadLastVisitedAtById[scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id))],
  );
  const statusKind = sidebarTopStatusKind(resolveSidebarThreadStatus(shell), {
    isUnread: hasUnseenCompletion({
      ...shell,
      lastVisitedAt: resolveThreadLastVisitedAt(shell.lastVisitedAt, localLastVisitedAt),
    }),
  });
  const status = statusKind === null ? null : SIDEBAR_TOP_STATUS[statusKind];
  return (
    <button
      type="button"
      onClick={() => onOpen(chief)}
      className={cn(PAGE_ROW_BUTTON_CLASS, "hover:bg-accent/60")}
    >
      <span className="mt-0.75 flex w-4 shrink-0 self-start">
        {status ? <status.Icon aria-hidden className={cn("size-4", status.className)} /> : null}
      </span>
      <PullRequestRowLines
        number={null}
        title={shell.title}
        signals={<FleetPullRequests shell={shell} />}
        status={
          <>
            {environmentConnected ? null : (
              <Badge variant="outline" size="sm">
                Offline
              </Badge>
            )}
            {status ? (
              <span className={cn("font-medium", status.className)} role="status">
                {status.label}
              </span>
            ) : null}
          </>
        }
        meta={
          <>
            <span className="inline-flex shrink-0 items-center gap-1">
              <EnvironmentMachineIcon kind={machine} aria-hidden className="size-3" />
              {environmentLabel}
            </span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{modelLabel}</span>
            <FleetReportLine chief={chief} threadIds={threadIds} />
          </>
        }
        updatedAt={shell.updatedAt}
      />
    </button>
  );
}

export function FleetPage() {
  const navigate = useNavigate();
  const board = useAtomValue(fleetBoardAtom);
  const providerEntries = useAtomValue(providerEntriesByEnvironmentAtom);
  const { environments } = useEnvironments();
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const threadIds = sortedThreadIdsByEnvironment(board);
  const open = (chief: FleetChief) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(chief.shell.environmentId, chief.shell.id)),
    });
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="relative bg-background">
          <WorkspaceBreadcrumb ariaLabel="Fleet breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Fleet</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="expanded" className="min-h-full gap-4">
            {board.length === 0 ? (
              <Empty className="flex-1">
                <EmptyHeader>
                  <EmptyTitle>No chiefs of staff</EmptyTitle>
                  <EmptyDescription>
                    Threads Home launches show here, grouped by job. A thread leaves when it is
                    settled, by you or by auto-settle, or archived.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="space-y-3">
                {board.map((group) => (
                  <section key={group.job ?? ""} className="space-y-0.5">
                    <ListGroupHeader
                      icon={group.job === null ? InboxIcon : BriefcaseIcon}
                      label={group.job ?? "No job"}
                      count={group.chiefs.length}
                    />
                    {group.chiefs.map((chief) => {
                      const { shell } = chief;
                      const environment = environmentById.get(shell.environmentId);
                      const instanceId =
                        shell.runtime?.providerInstanceId ?? shell.modelSelection.instanceId;
                      return (
                        <FleetChiefRow
                          key={scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id))}
                          chief={chief}
                          threadIds={threadIds.get(shell.environmentId) ?? []}
                          environmentLabel={environment?.label ?? shell.environmentId}
                          machine={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
                          modelLabel={providerModelLabel(
                            providerEntries.get(shell.environmentId)?.get(instanceId),
                            shell.modelSelection.model,
                          )}
                          onOpen={open}
                        />
                      );
                    })}
                  </section>
                ))}
              </div>
            )}
          </WorkspacePageContainer>
        </div>
      </div>
    </SidebarInset>
  );
}
