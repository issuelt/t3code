import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import {
  formatThreadLink,
  replaceThreadLinks,
  threadLinkCandidates,
  type ThreadLink,
} from "./threadLinks.ts";

/** @public */
export function unknownThreadLinkLabel(
  link: ThreadLink,
  messageEnvironmentId: EnvironmentId,
  resolve: MFunctionType = mFallback,
): string {
  return link.environmentId === null || link.environmentId === messageEnvironmentId
    ? resolve(msg("Thread no longer available"))
    : resolve(msg("Thread on another machine"));
}

/**
 * Writes each link with its thread's current title, a hosted link as a v2 link. A link `title`
 * cannot resolve keeps its written label or a neutral one, and a labeled v1 link stays as written.
 */
export function relabelThreadLinks(
  markdown: string,
  messageEnvironmentId: EnvironmentId,
  title: (ref: ScopedThreadRef, label: string | undefined) => string | undefined,
  resolve: MFunctionType = mFallback,
): string {
  return replaceThreadLinks(markdown, (written, label) => {
    for (const ref of threadLinkCandidates(written, messageEnvironmentId)) {
      const current = title(ref, label);
      if (current === undefined) continue;
      return formatThreadLink(
        { environmentId: written.environmentId, threadId: ref.threadId },
        current.trim() || label || ref.threadId,
      );
    }
    if (label !== undefined && written.environmentId === null) return undefined;
    // Not loaded is not gone: keep a link that still opens the thread.
    return formatThreadLink(
      written,
      label?.trim() ||
        (written.environmentId === null || written.environmentId === messageEnvironmentId
          ? resolve(msg("Thread"))
          : unknownThreadLinkLabel(written, messageEnvironmentId, resolve)),
    );
  });
}
