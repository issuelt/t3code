import {
  type GuestMessageAttribution,
  HOME_REPORT_MESSAGE_ID_PREFIX,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2IdleCompaction,
  ScheduledTaskId,
} from "@t3tools/contracts";
import { isAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";

/** The working row while T3 Code's own compaction runs. */
export const IDLE_COMPACTING_LABELS = {
  beforeCacheExpires: "Compacting before the cache expires…",
  onReturn: "Compacting…",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

/** Leads the finished compaction's token counts, in place of "Context compacted". */
export const IDLE_COMPACTION_TITLES = {
  beforeCacheExpires: "Context automatically compacted before cache expiry",
  onReturn: "Context compacted before sending",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

const LEGACY_AUTOMATION_PREFIX = /^\[Triggered by schedule task: [^\r\n]+\]\r?\n\r?\n/;
const LEGACY_AUTOMATION_MESSAGE_ID = /^scheduled-task-message:(.+):\d+:(?:scheduled|manual)$/;

export function resolveUserMessagePresentation(message: {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: ScheduledTaskId | undefined;
  /** Set only when another thread sent the message, including a result the server returned for it. */
  readonly senderThreadId?: string | undefined;
  readonly context?: { readonly guest?: GuestMessageAttribution | undefined } | undefined;
}): {
  readonly text: string;
  readonly attribution: "automation" | "agent" | "t3code" | "guest" | null;
  readonly scheduledTaskId: ScheduledTaskId | undefined;
  /** Set when `attribution` is "guest". */
  readonly guestName?: string;
} {
  if (message.role !== "user") {
    return { text: message.text, attribution: null, scheduledTaskId: undefined };
  }
  // The stored text names the guest for the agent; people see the guest's own words.
  const guest = message.context?.guest;
  if (guest !== undefined) {
    return {
      text: guest.text,
      attribution: "guest",
      scheduledTaskId: undefined,
      guestName: guest.name,
    };
  }
  if (message.scheduledTaskId !== undefined) {
    return {
      text: message.text,
      attribution: "automation",
      scheduledTaskId: message.scheduledTaskId,
    };
  }
  const legacyPrefix = LEGACY_AUTOMATION_PREFIX.exec(message.text);
  const legacyTaskId = legacyPrefix
    ? LEGACY_AUTOMATION_MESSAGE_ID.exec(message.id ?? "")?.[1]
    : undefined;
  if (legacyPrefix !== null && (legacyTaskId !== undefined || message.createdBy === "agent")) {
    return {
      text: message.text.slice(legacyPrefix[0].length),
      attribution: "automation",
      scheduledTaskId: legacyTaskId === undefined ? undefined : ScheduledTaskId.make(legacyTaskId),
    };
  }
  return {
    // The agent needs words to start a turn; people sent only the attachments.
    text: isAttachmentOnlyBootstrapPrompt(message.text) ? "" : message.text,
    attribution:
      message.senderThreadId !== undefined
        ? "agent"
        : message.createdBy !== "agent"
          ? null
          : message.creationSource === "server"
            ? "t3code"
            : "agent",
    scheduledTaskId: undefined,
  };
}

const WATCH_REPORT_EVENT =
  /^- (?<event>[^:\n]+): (?:\[(?<title>[^\]\n]*)\]\((?<titledHref>[^)\n]*)\)|<(?<href>[^>\n]*)>).*\bthreadId (?<threadId>[^)\s]+)\)/;

/** Each watched event in a watch report, once. Null for any other message. */
function watchReportEvents(
  messageId: string,
  text: string,
): ReadonlyArray<{ readonly event: string; readonly title: string; readonly href: string }> | null {
  if (!messageId.startsWith(HOME_REPORT_MESSAGE_ID_PREFIX)) return null;
  const events = new Map<string, { event: string; title: string; href: string }>();
  for (const line of text.split("\n")) {
    const groups = WATCH_REPORT_EVENT.exec(line)?.groups;
    if (groups === undefined) continue;
    const event = {
      event: groups.event ?? "",
      title: groups.title?.trim() || (groups.threadId ?? ""),
      href: groups.titledHref ?? groups.href ?? "",
    };
    events.set(`${event.event}\n${event.href}`, event);
  }
  return [...events.values()];
}

/**
 * The folded lines of a watch report, one per watched event, such as
 * "Completed · OS exam study guide app". Null for any other message.
 */
export function watchReportSummaryLines(
  messageId: string,
  text: string,
): ReadonlyArray<string> | null {
  return (
    watchReportEvents(messageId, text)?.map(({ event, title }) => `${event} · ${title}`) ?? null
  );
}

/**
 * What an expanded watch report shows: each event with a link to its thread. The model reads
 * the full text with its envelope; the ids in it are for the model, not the user.
 */
export function watchReportMarkdown(messageId: string, text: string): string | null {
  const events = watchReportEvents(messageId, text);
  if (events === null || events.length === 0) return null;
  return events
    .map(({ event, title, href }) =>
      href === "" ? `${event} · ${title}` : `${event} · [${title.replaceAll("]", "\\]")}](${href})`,
    )
    .join("\n\n");
}

/** The header of an expanded watch report, whose body already lists each event. */
export function watchReportHeading(eventCount: number): string {
  return eventCount > 1 ? `Watch report · ${eventCount} events` : "Watch report";
}
