import {
  type ChatAttachment,
  type ChatFileAttachment,
  type GuestMessageAttribution,
  HOME_REPORT_MESSAGE_ID_PREFIX,
  isAgentDeliveredMessage,
  type OrchestrationV2ConversationMessage,
  type OrchestrationMessageContext,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2IdleCompaction,
  type OrchestrationV2UserMessageInputIntent,
  ScheduledTaskId,
} from "@t3tools/contracts";
import {
  isAttachmentOnlyBootstrapPrompt,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { filePreviewKind } from "@t3tools/shared/filePreview";
import { imageMimeType } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";

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

export function resolveUserMessageFileCards(message: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext | undefined;
}): ReadonlyArray<ChatFileAttachment> | null {
  const files = message.attachments.filter(
    (attachment): attachment is ChatFileAttachment =>
      attachment.type === "file" &&
      imageMimeType(attachment) === null &&
      videoMimeType(attachment) === null &&
      filePreviewKind(attachment) !== "audio",
  );
  if (files.length === 0 || files.length !== message.attachments.length) return null;
  const fileIds = new Set(files.map((file) => file.id));
  const remaining = replaceComposerContextReferences(message.text, (reference) => {
    const record = message.context?.records.find((item) => item.contextId === reference.contextId);
    return reference.kind === "file" &&
      record?.kind === "file" &&
      "attachmentId" in record &&
      fileIds.has(record.attachmentId)
      ? ""
      : reference.label || reference.kind;
  });
  return remaining.trim() === "" ? files : null;
}

export function resolveUserMessagePresentation(message: {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: ScheduledTaskId | undefined;
  /** Set only when another thread sent the message, including a result the server returned for it. */
  readonly senderThreadId?: string | undefined;
  readonly coordination?: OrchestrationV2ConversationMessage["coordination"] | undefined;
  readonly idleCompaction?: OrchestrationV2IdleCompaction | undefined;
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
    attribution: isAgentDeliveredMessage("", message)
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

type GroupableUserMessage = Parameters<typeof resolveUserMessagePresentation>[0] & {
  readonly inputIntent?: OrchestrationV2UserMessageInputIntent;
};

export function resolveUserMessageGrouping(
  message: GroupableUserMessage | undefined,
  previous: GroupableUserMessage | undefined,
  next: GroupableUserMessage | undefined,
) {
  const isOwnMessage = (value: GroupableUserMessage | undefined) =>
    value?.role === "user" && resolveUserMessagePresentation(value).attribution === null;
  const isSteer = (value: GroupableUserMessage | undefined) =>
    value?.inputIntent === "steer" || value?.inputIntent === "promoted_queued_to_steer";
  const groupedWithPrevious = isOwnMessage(message) && isOwnMessage(previous);
  return {
    groupedWithPrevious,
    groupedWithNext: isOwnMessage(message) && isOwnMessage(next),
    continuesSteer: groupedWithPrevious && isSteer(message) && isSteer(previous),
  };
}
