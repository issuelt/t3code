import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  formatThreadLink,
  guessThreadLinkRef,
  percentDecodedThreadLinkId,
  type ThreadLink,
  unknownThreadLinkLabel,
} from "@t3tools/shared/threadLinks";

import { useThreadRefs, useThreadShell } from "../../state/entities";
import { ThreadContextChip } from "../ThreadContextChip";

/** `label` is the link's written text; an autolink has none. */
export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly link: ThreadLink;
  readonly label: string | null;
}) {
  const environmentId = props.link.environmentId ?? props.environmentId;
  const decodedId = percentDecodedThreadLinkId(props.link.threadId);
  const written = useThreadShell(scopeThreadRef(environmentId, props.link.threadId));
  const decoded = useThreadShell(
    written === null && decodedId !== null ? scopeThreadRef(environmentId, decodedId) : null,
  );
  const local = written ?? decoded;
  const guess = local === null && props.link.environmentId === null;
  const refs = useThreadRefs(guess);
  const remote = useThreadShell(guess ? guessThreadLinkRef(props.link, refs) : null);
  const thread = local ?? remote;
  // Older settled threads and other machines' threads are often not loaded here yet; the
  // link's own ids still open them, so a cache miss stays a chip.
  const ref =
    thread === null
      ? { environmentId, threadId: props.link.threadId }
      : { environmentId: thread.environmentId, threadId: thread.id };
  const title =
    thread?.title.trim() ||
    props.label ||
    (thread === null ? unknownThreadLinkLabel(props.link, props.environmentId) : "Untitled thread");
  return (
    <ThreadContextChip record={{ ...ref, title }} copyMarkdown={formatThreadLink(ref, title)} />
  );
}
