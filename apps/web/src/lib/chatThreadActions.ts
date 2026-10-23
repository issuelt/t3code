import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ScopedProjectRef,
  isHomeThreadId,
} from "@t3tools/contracts";
import type { ComposerThreadDraftState, DraftThreadEnvMode } from "../composerDraftStore";

type ComposerModelSelectionState = Pick<
  ComposerThreadDraftState,
  "activeProvider" | "modelSelectionByProvider" | "modelSelectionExplicit"
>;

interface ThreadContextLike {
  /** A thread shell's id. */
  id?: string;
  /** A draft's thread id, set while its thread shell is not loaded yet. */
  threadId?: string;
  environmentId: EnvironmentId;
  projectId: ProjectId;
}

interface NewThreadHandler {
  (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
    },
  ): Promise<unknown>;
}

export interface ChatThreadActionContext {
  readonly activeDraftThread: ThreadContextLike | null;
  readonly activeThread: ThreadContextLike | undefined;
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly handleNewThread: NewThreadHandler;
}

export function resolveNewDraftStartFromOrigin(input: {
  envMode: DraftThreadEnvMode;
  newWorktreesStartFromOrigin: boolean;
}): boolean {
  return input.envMode === "worktree" && input.newWorktreesStartFromOrigin;
}

export function resolveNewThreadModelSelectionOverride(input: {
  readonly projectDefaultSelection: ModelSelection | null;
  readonly carrySelection: ModelSelection | null;
  readonly carrySourceDraftId: string | null;
  readonly destinationDraftId: string;
}): ModelSelection | null {
  return (
    input.projectDefaultSelection ??
    (input.carrySourceDraftId === input.destinationDraftId ? null : input.carrySelection)
  );
}

export function hasExplicitComposerModelSelection(
  draft: ComposerModelSelectionState | null | undefined,
): boolean {
  const activeProvider = draft?.activeProvider;
  return (
    draft?.modelSelectionExplicit === true &&
    activeProvider !== null &&
    activeProvider !== undefined &&
    draft.modelSelectionByProvider[activeProvider] !== undefined
  );
}

/**
 * The project a new thread starts in when nothing else picks one: the first in
 * order that is not Home's folder, which belongs to Home alone.
 */
export function defaultNewThreadProjectRef(
  projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>,
  home: {
    readonly primaryEnvironmentId: EnvironmentId | null;
    readonly homeWorkspaceRoot: string | null;
  },
): ScopedProjectRef | null {
  const homeRoot =
    home.homeWorkspaceRoot === null
      ? ""
      : normalizeProjectPathForComparison(home.homeWorkspaceRoot);
  const project = projects.find(
    (candidate) =>
      homeRoot.length === 0 ||
      candidate.environmentId !== home.primaryEnvironmentId ||
      normalizeProjectPathForComparison(candidate.workspaceRoot) !== homeRoot,
  );
  return project ? scopeProjectRef(project.environmentId, project.id) : null;
}

export function resolveThreadActionProjectRef(
  context: ChatThreadActionContext,
): ScopedProjectRef | null {
  // Home's folder belongs to Home alone, so a new thread from Home, or from a
  // draft in Home's composer, uses the default project.
  if (
    isHomeThreadId(context.activeThread?.id ?? "") ||
    isHomeThreadId(context.activeDraftThread?.threadId ?? "")
  ) {
    return context.defaultProjectRef;
  }
  if (context.activeThread) {
    return scopeProjectRef(context.activeThread.environmentId, context.activeThread.projectId);
  }
  if (context.activeDraftThread) {
    return scopeProjectRef(
      context.activeDraftThread.environmentId,
      context.activeDraftThread.projectId,
    );
  }
  return context.defaultProjectRef;
}

export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  await context.handleNewThread(projectRef);
  return true;
}
