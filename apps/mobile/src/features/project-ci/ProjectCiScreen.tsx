import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ProjectCiInput, ProjectCiRunDetails } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { use, useState } from "react";
import { Linking, Platform, RefreshControl, ScrollView, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects } from "../../state/entities";
import { useWorkspaceState } from "../../state/workspace";
import { useDeadlinePassed } from "../../lib/clock";
import { PullRequestCardRow } from "../pull-requests/PullRequestControls";
import { projectCiRead, projectCiRunRead } from "../../state/project-ci";
import { ListFilterMenu } from "../workspace/ListFilterMenu";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { useAndroidWorkspaceBack } from "../workspace/useAndroidWorkspaceNavigation";
import {
  ciRunFailed,
  preferredCiRemote,
  visibleCiRuns,
  type CiFilter,
  type CiRun,
} from "./projectCiModel";

import { createCiRunDetailsView, type CiRunTarget } from "./projectCiRunState";

const ciRunDetails = createCiRunDetailsView(projectCiRunRead);

type CiTarget = { readonly environmentId: EnvironmentId; readonly input: ProjectCiInput };
type SelectedCiTarget = {
  readonly environmentId: EnvironmentId;
  readonly input: ProjectCiInput & { readonly remoteName: string };
};

function useCiRead(target: CiTarget) {
  const registry = use(RegistryContext);
  const atom = projectCiRead(target);
  const result = useAtomValue(atom);
  const value = Option.getOrNull(AsyncResult.value(result));
  const expired = useDeadlinePassed(value ? Date.parse(value.fetchedAt) + 60_000 : null);
  const error = AsyncResult.isFailure(result) ? Cause.squash(result.cause) : null;
  const { environments } = useWorkspaceState();
  const connected = environments.some(
    (item) => item.environmentId === target.environmentId && item.connectionState === "connected",
  );
  return {
    value,
    error: error === null ? null : error instanceof Error ? error.message : "Could not read CI.",
    waiting: result.waiting,
    stale: expired || !connected || error !== null || result.waiting,
    refresh: () => {
      if (!result.waiting) registry.refresh(atom);
    },
  };
}

function CiReadStatus({
  read,
}: {
  readonly read: Omit<ReturnType<typeof useCiRead>, "value"> & {
    readonly value: { readonly fetchedAt: string } | null;
  };
}) {
  return (
    <View className="gap-2">
      <Text className="text-sm text-foreground-muted">
        {read.value
          ? `Updated ${new Date(read.value.fetchedAt).toLocaleString()}${read.stale ? " · Stale" : ""}`
          : read.waiting
            ? "Loading CI…"
            : "No CI data loaded."}
      </Text>
      {read.error ? (
        <Text selectable className="text-sm text-danger">
          {read.error}
        </Text>
      ) : null}
      <Button
        label={read.waiting ? "Refreshing…" : "Refresh"}
        disabled={read.waiting}
        onPress={read.refresh}
      />
    </View>
  );
}

export function ProjectCiScreen() {
  const projects = useProjects();
  const { environments } = useWorkspaceState();
  const environmentLabel = (id: EnvironmentId) =>
    environments.find((item) => item.environmentId === id)?.environmentLabel ?? id;
  const [selected, setSelected] = useState<string | null>(null);
  const projectKey = (project: (typeof projects)[number]) =>
    JSON.stringify([project.environmentId, project.id]);
  const project = projects.find((item) => projectKey(item) === selected) ?? projects[0];
  return (
    <View className="flex-1 bg-screen">
      {Platform.OS === "android" ? <AndroidScreenHeader title="CI" /> : null}
      <View className="px-4 py-3">
        <ListFilterMenu
          label={
            project
              ? `${project.title} · ${environmentLabel(project.environmentId)}`
              : "Choose project"
          }
          accessibilityLabel="CI project and environment"
          actions={projects.map((item) => ({
            id: projectKey(item),
            title: `${item.title} · ${environmentLabel(item.environmentId)}`,
            state: item === project ? "on" : "off",
          }))}
          onSelect={setSelected}
        />
      </View>
      {project ? (
        <ProjectCiList
          key={projectKey(project)}
          target={{ environmentId: project.environmentId, input: { projectId: project.id } }}
        />
      ) : (
        <Text className="p-4 text-foreground-muted">Add a project to view its CI runs.</Text>
      )}
    </View>
  );
}

function ProjectCiList({ target }: { readonly target: CiTarget }) {
  const discovery = useCiRead(target);
  const [remoteName, setRemoteName] = useState<string | null>(null);
  const [provider, setProvider] = useState<ProjectCiInput["provider"]>(undefined);
  const remote =
    discovery.value?.remotes.find((item) => item.name === remoteName) ??
    preferredCiRemote(discovery.value?.remotes ?? []);
  return (
    <View className="flex-1">
      <ScrollView
        horizontal
        className="max-h-14"
        contentContainerStyle={{ paddingHorizontal: 16, gap: 12, paddingVertical: 8 }}
      >
        <ListFilterMenu
          label={remote?.name ?? "Remote"}
          accessibilityLabel="CI remote"
          actions={(discovery.value?.remotes ?? []).map((item) => ({
            id: item.name,
            title: `${item.name} · ${item.host}/${item.repository}`,
            state: item.name === remote?.name ? "on" : "off",
          }))}
          onSelect={(name) => {
            setRemoteName(name);
            setProvider(undefined);
          }}
        />
        <ListFilterMenu
          label={provider ?? remote?.provider ?? "Auto provider"}
          accessibilityLabel="CI provider"
          actions={[
            { id: "auto", title: "Auto" },
            { id: "github", title: "GitHub" },
            { id: "gitlab", title: "GitLab" },
          ]}
          onSelect={(id) => setProvider(id === "github" || id === "gitlab" ? id : undefined)}
        />
      </ScrollView>
      {remote ? (
        <CiRuns
          key={JSON.stringify([remote.name, provider])}
          target={{
            ...target,
            input: { ...target.input, remoteName: remote.name, ...(provider ? { provider } : {}) },
          }}
          refreshRemotes={discovery.refresh}
        />
      ) : (
        <ScreenScrollView
          contentContainerStyle={{ padding: 16, gap: 12 }}
          refreshControl={
            <RefreshControl refreshing={discovery.waiting} onRefresh={discovery.refresh} />
          }
        >
          <CiReadStatus read={discovery} />
          {discovery.value && !discovery.waiting && !discovery.error ? (
            <Text className="text-foreground-muted">No registered Git remotes found.</Text>
          ) : null}
        </ScreenScrollView>
      )}
    </View>
  );
}

function CiRuns({
  target,
  refreshRemotes,
}: {
  readonly target: SelectedCiTarget;
  readonly refreshRemotes: () => void;
}) {
  const result = useCiRead(target);
  const read = {
    ...result,
    refresh: () => {
      result.refresh();
      refreshRemotes();
    },
  };
  const navigation = useNavigation();
  const workspace = useWorkspaceTabs();
  const [filter, setFilter] = useState<CiFilter>("all");
  const [query, setQuery] = useState("");
  const runs = visibleCiRuns(read.value?.runs ?? [], filter, query);
  return (
    <ScreenScrollView
      contentContainerStyle={{
        padding: 16,
        gap: 16,
        paddingBottom: workspace?.bottomClearance ?? 24,
      }}
      refreshControl={<RefreshControl refreshing={read.waiting} onRefresh={read.refresh} />}
    >
      <TextInput
        accessibilityLabel="Filter CI runs by name, branch or commit"
        placeholder="Filter name, branch or commit"
        value={query}
        onChangeText={setQuery}
        className="rounded-xl bg-surface px-4 py-3 text-foreground"
      />
      <ListFilterMenu
        label={filter === "all" ? "All runs" : filter === "active" ? "Active" : "Failed"}
        accessibilityLabel="CI run status"
        actions={[
          { id: "all", title: "All runs" },
          { id: "active", title: "Active" },
          { id: "failed", title: "Failed" },
        ]}
        onSelect={(id) => {
          if (id === "all" || id === "active" || id === "failed") setFilter(id);
        }}
      />
      <CiReadStatus read={read} />
      {read.value?.selectedRemote ? (
        <Text selectable className="text-sm text-foreground-muted">
          {read.value.selectedRemote.host}/{read.value.selectedRemote.repository} ·{" "}
          {read.value.selectedRemote.name} ·{" "}
          {read.value.selectedRemote.provider ?? "Unknown provider"}
        </Text>
      ) : null}
      {read.value?.activeRunsIncomplete ? (
        <Text className="text-foreground-muted">
          Some active runs could not be checked. Recent and successfully checked runs are shown.
          Pull to refresh to retry.
        </Text>
      ) : null}
      {read.value?.activeRunsTruncated ? (
        <Text className="text-foreground-muted">
          Active run limit reached. More runs may be available on the provider.
        </Text>
      ) : null}
      {runs.map((run) => (
        <View key={run.id} className="rounded-xl bg-surface">
          <PullRequestCardRow
            title={run.name}
            icon={ciRunFailed(run) ? "exclamationmark.triangle" : "checkmark.circle"}
            detail={`${run.conclusion ?? run.status} · ${run.branch ?? run.sha.slice(0, 8)}`}
            onPress={() => navigation.navigate("ProjectCiRun", { target, run })}
            last
          />
        </View>
      ))}
      {read.value && !runs.length && !read.waiting && !read.error ? (
        <Text className="text-foreground-muted">No matching CI runs.</Text>
      ) : null}
      <Text className="text-xs text-foreground-muted">
        Active and recent runs. Pull to refresh for the latest status.
      </Text>
    </ScreenScrollView>
  );
}

export function ProjectCiRunScreen({
  route,
}: StaticScreenProps<{ target: SelectedCiTarget; run: CiRun }>) {
  const { target, run: fallback } = route.params;
  const registry = use(RegistryContext);
  const detailTarget: CiRunTarget = {
    environmentId: target.environmentId,
    input: { ...target.input, runId: fallback.id },
  };
  const result = useAtomValue(ciRunDetails({ target: detailTarget, fallback }));
  const { environments } = useWorkspaceState();
  const expired = useDeadlinePassed(
    result.value ? Date.parse(result.value.fetchedAt) + 60_000 : null,
  );
  const connected = environments.some(
    (item) => item.environmentId === target.environmentId && item.connectionState === "connected",
  );
  const read = {
    ...result,
    stale: expired || !connected || result.error !== null || result.waiting,
    refresh: () => {
      if (!result.waiting) registry.refresh(projectCiRunRead(detailTarget));
    },
  };
  const run = result.run;
  const details = result.value?.run;
  useAndroidWorkspaceBack("ci");
  return (
    <>
      <NativeStackScreenOptions options={{ title: run.name }} />
      <ScreenScrollView
        contentContainerStyle={{ padding: 16, gap: 16 }}
        refreshControl={<RefreshControl refreshing={read.waiting} onRefresh={read.refresh} />}
      >
        <Text className="text-lg font-semibold text-foreground">{run.name}</Text>
        <Text selectable className="text-foreground-muted">
          {run.conclusion ?? run.status} · {run.branch ?? "No branch"} · {run.sha.slice(0, 8)}
        </Text>
        <CiReadStatus read={read} />
        <CiLink label="Open run" url={run.url} />
        {details?.jobsError ? (
          <Text className="text-danger">
            Some jobs could not be loaded ({details?.jobsError}). More jobs, including failures, may
            be available. Refresh or open the run to retry.
          </Text>
        ) : null}
        {details?.jobsTruncated ? (
          <Text className="text-foreground-muted">
            Job limit reached. More jobs, including failures, may be available. Open the run to see
            all jobs.
          </Text>
        ) : null}
        {details?.jobs.map((job) => (
          <CiJob key={`${job.url}:${job.name}:${job.startedAt}`} job={job} />
        ))}
        {details && !details.jobs.length && !details.jobsError ? (
          <Text className="text-foreground-muted">No jobs reported for this run.</Text>
        ) : null}
      </ScreenScrollView>
    </>
  );
}

function CiJob({ job }: { readonly job: ProjectCiRunDetails["jobs"][number] }) {
  const [expanded, setExpanded] = useState(() => ciRunFailed(job));
  return (
    <View className="rounded-xl bg-surface">
      <PullRequestCardRow
        title={job.name}
        icon={ciRunFailed(job) ? "exclamationmark.triangle" : "checkmark.circle"}
        value={job.conclusion ?? job.status}
        expanded={expanded}
        onPress={() => setExpanded((value) => !value)}
        last
      />
      {expanded ? (
        <View className="gap-2 px-4 pb-4">
          {job.startedAt ? (
            <Text className="text-sm text-foreground-muted">
              Started {new Date(job.startedAt).toLocaleString()}
            </Text>
          ) : null}
          {job.completedAt ? (
            <Text className="text-sm text-foreground-muted">
              Completed {new Date(job.completedAt).toLocaleString()}
            </Text>
          ) : null}
          <CiLink label={ciRunFailed(job) ? "Open failure details" : "Open job"} url={job.url} />
        </View>
      ) : null}
    </View>
  );
}

function CiLink({ label, url }: { readonly label: string; readonly url: string }) {
  const [error, setError] = useState(false);
  return (
    <View className="gap-2">
      <Button
        label={label}
        onPress={() => {
          setError(false);
          void Linking.openURL(url).catch(() => setError(true));
        }}
      />
      {error ? <Text className="text-danger">Could not open link.</Text> : null}
    </View>
  );
}
