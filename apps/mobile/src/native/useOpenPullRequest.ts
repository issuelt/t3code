import { useNavigation, useRoute, StackActions } from "@react-navigation/native";
import { nativePullRequestDestination } from "../lib/pullRequestNavigation";
import { Platform } from "react-native";
import { useSelectWorkspaceDetail } from "../features/layout/workspace/useSelectWorkspaceDetail";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useProjects, useThreadShell } from "../state/entities";
import { tryOpenExternalUrl } from "../lib/openExternalUrl";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentServerConfigsAtom } from "../state/server";
import { withKnownPullRequestSummary } from "../state/use-thread-pr";

type PullRequestContext = { readonly environmentId: string; readonly projectId: string };

// Route-free so navigator layouts such as the workspace sidebar, which have no
// route context for useRoute, can open pull requests for any thread.
export function useNavigateToPullRequest(options?: {
  readonly replace?: boolean;
  readonly mode?: "contextual" | "workspace";
}) {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const projects = useProjects();
  const replace = options?.replace;
  const mode = options?.mode ?? "workspace";
  return async (url: string, context: PullRequestContext | null) => {
    // Read at press time so a config push does not hand every link a new handler.
    const serverConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
    const destination = nativePullRequestDestination(url, context, projects, (environmentId) =>
      serverConfigs.has(environmentId),
    );
    if (!destination) return tryOpenExternalUrl(url, "pull-request");
    const params = withKnownPullRequestSummary(destination);
    // Contextual links open over the current page, so Back returns to the chat they came from.
    if (Platform.OS === "android" && mode === "workspace")
      selectDetail({ name: "PullRequest", params });
    else if (replace) navigation.dispatch(StackActions.replace("PullRequest", params));
    else navigation.dispatch(StackActions.push("PullRequest", params));
    return true;
  };
}

export function useOpenPullRequest(options?: {
  readonly replace?: boolean;
  readonly mode?: "contextual" | "workspace";
  readonly context?: PullRequestContext;
}) {
  const route = useRoute();
  const routeContext = route.params as
    | {
        environmentId?: string | string[];
        projectId?: string | string[];
        threadId?: string | string[];
      }
    | undefined;
  const first = (value: string | string[] | undefined) => {
    const text = Array.isArray(value) ? value[0] : value;
    return text?.trim() ? text : undefined;
  };
  const environmentId = options?.context?.environmentId ?? first(routeContext?.environmentId);
  const threadId = first(routeContext?.threadId);
  const thread = useThreadShell(
    environmentId && threadId
      ? { environmentId: EnvironmentId.make(environmentId), threadId: ThreadId.make(threadId) }
      : null,
  );
  const projectId =
    options?.context?.projectId ?? first(routeContext?.projectId) ?? thread?.projectId;
  const navigateToPullRequest = useNavigateToPullRequest({
    replace: options?.replace,
    mode: options?.mode ?? "contextual",
  });
  return (url: string) =>
    navigateToPullRequest(
      url,
      environmentId && projectId
        ? { environmentId: String(environmentId), projectId: String(projectId) }
        : null,
    );
}
