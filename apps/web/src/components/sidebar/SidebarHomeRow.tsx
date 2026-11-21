import { useGT, useMessages } from "gt-react";
import { memo } from "react";
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { HouseIcon } from "lucide-react";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useQuietThreadShell } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { cn } from "../../lib/utils";
import {
  hasUnseenCompletion,
  resolveThreadLastVisitedAt,
  resolveSidebarThreadStatus,
  type SidebarV2TopStatusKind,
} from "../Sidebar.logic";
import { SIDEBAR_TOP_STATUS, sidebarTopStatusKind } from "./sidebarTopStatus";
import { SidebarTopRow } from "./SidebarTopRow";

// Home keeps its brighter tones, and Waiting shows no icon: it is calm background presence.
const HOME_STATUS_TONE: Partial<Record<SidebarV2TopStatusKind, string>> = {
  working: "text-info",
  limited: "text-warning",
  failed: "text-error",
  woke: "text-warning",
  done: "text-success",
};

/**
 * Each environment's Home row, above every other row. With more than one, dragging reorders
 * them among themselves; the order is saved per client.
 */
export function SidebarHomeRows(props: {
  threadRefs: readonly ScopedThreadRef[];
  environmentLabelById: ReadonlyMap<EnvironmentId, string>;
  activeThreadKey: string | null;
  onActivate: (threadRef: ScopedThreadRef) => void;
}) {
  const { activeThreadKey, environmentLabelById, onActivate, threadRefs } = props;
  const setSidebarHomeOrder = useUiStateStore((state) => state.setSidebarHomeOrder);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const ids = threadRefs.map(scopedThreadKey);
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over === null || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    setSidebarHomeOrder(arrayMove([...threadRefs], from, to).map((ref) => ref.environmentId));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {threadRefs.map((threadRef, index) => (
          <SidebarHomeRow
            key={ids[index]}
            threadRef={threadRef}
            environmentLabel={
              threadRefs.length > 1
                ? (environmentLabelById.get(threadRef.environmentId) ?? null)
                : null
            }
            isActive={activeThreadKey === ids[index]}
            sortable={threadRefs.length > 1}
            onActivate={onActivate}
          />
        ))}
      </SortableContext>
    </DndContext>
  );
}

/** One Home thread. Home has no project, settle, or pin affordances, so it only shows its status. */
const SidebarHomeRow = memo(function SidebarHomeRow(props: {
  threadRef: ScopedThreadRef;
  /** Names the machine when more than one environment runs Home. */
  environmentLabel: string | null;
  isActive: boolean;
  sortable: boolean;
  onActivate: (threadRef: ScopedThreadRef) => void;
}) {
  const { environmentLabel, isActive, onActivate, threadRef } = props;
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: scopedThreadKey(threadRef),
    disabled: !props.sortable,
  });
  const gt = useGT();
  const messages = useMessages();
  const label = environmentLabel === null ? "Home" : `Home · ${environmentLabel}`;
  const thread = useQuietThreadShell(threadRef);
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const topStatusKind =
    thread === null
      ? null
      : sidebarTopStatusKind(resolveSidebarThreadStatus(thread), {
          isUnread: hasUnseenCompletion({
            ...thread,
            lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
          }),
        });
  const topStatus = topStatusKind === null ? null : SIDEBAR_TOP_STATUS[topStatusKind];
  const topStatusLabel = topStatus ? messages(topStatus.label) : null;
  return (
    <SidebarTopRow
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      dragListeners={listeners}
      isDragging={isDragging}
      label={topStatusLabel ? gt("{label}, {status}", { label, status: topStatusLabel }) : label}
      isActive={isActive}
      testId="sidebar-home-row"
      icon={<HouseIcon aria-hidden className="size-4 shrink-0" />}
      title={label}
      onActivate={() => onActivate(threadRef)}
      trailing={
        topStatusKind !== null && topStatus ? (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 text-xs font-medium",
              HOME_STATUS_TONE[topStatusKind] ?? topStatus.className,
            )}
          >
            {topStatusKind === "waiting" ? null : (
              <topStatus.Icon aria-hidden className="size-4 shrink-0" />
            )}
            <span role="status">{topStatusLabel}</span>
          </span>
        ) : null
      }
    />
  );
});
