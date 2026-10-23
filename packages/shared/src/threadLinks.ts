import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Agents mention another thread in Markdown as `[title](t3-thread://v1/<threadId>)`. The id is
 * the reference and resolves in the environment of the message that holds it. Titles change, so
 * clients show the thread's current title; the label only stands in for a thread they cannot see.
 * A link to a thread in another environment, which only Home writes, adds
 * `?environmentId=<percent-encoded id>`; thread tools return it ready-made as `link`.
 */
export const THREAD_LINK_PROTOCOL = "t3-thread";
const THREAD_LINK_HREF_PREFIX = `${THREAD_LINK_PROTOCOL}://v1/`;
// Code comes first in the alternation so a link written inside a code span or fence is skipped.
const THREAD_LINK_OUTSIDE_CODE =
  /(?<fence>(`{3,}|~{3,})[\s\S]*?(?:\2|$))|(?<span>(`+)[^\n]*?\4)|\[[^\]\n]*\]\((?<href>t3-thread:\/\/v1\/[^\s)]+)\)/g;

const ENVIRONMENT_QUERY = "?environmentId=";

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);
const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);

function splitThreadLinkHref(href: string): { readonly id: string; readonly env: string | null } {
  const rest = href.slice(THREAD_LINK_HREF_PREFIX.length);
  const query = rest.indexOf(ENVIRONMENT_QUERY);
  return query === -1
    ? { id: rest, env: null }
    : { id: rest.slice(0, query), env: rest.slice(query + ENVIRONMENT_QUERY.length) };
}

/** The id as written. Thread ids can hold percent escapes of their own, so it is not decoded. */
export function parseThreadLinkHref(href: string): ThreadId | null {
  if (!href.startsWith(THREAD_LINK_HREF_PREFIX)) return null;
  return Option.getOrNull(decodeThreadId(splitThreadLinkHref(href).id));
}

/** The environment a thread link names, or null when it resolves where the message lives. */
export function parseThreadLinkEnvironmentId(href: string): EnvironmentId | null {
  if (!href.startsWith(THREAD_LINK_HREF_PREFIX)) return null;
  const { env } = splitThreadLinkHref(href);
  if (env === null) return null;
  try {
    return Option.getOrNull(decodeEnvironmentId(decodeURIComponent(env)));
  } catch {
    return null;
  }
}

export function percentDecodedThreadLinkId(threadId: ThreadId): ThreadId | null {
  try {
    const decoded = decodeURIComponent(threadId);
    return decoded === threadId ? null : Option.getOrNull(decodeThreadId(decoded));
  } catch {
    return null;
  }
}

export function resolveThreadLinkRef(
  source: ScopedThreadRef,
  refs: ReadonlyArray<ScopedThreadRef>,
): ScopedThreadRef | null {
  const decodedId = percentDecodedThreadLinkId(source.threadId);
  const ids = decodedId === null ? [source.threadId] : [source.threadId, decodedId];
  for (const threadId of ids) {
    const local = refs.find(
      (ref) => ref.environmentId === source.environmentId && ref.threadId === threadId,
    );
    if (local) return local;
  }
  for (const threadId of ids) {
    let match: ScopedThreadRef | null = null;
    for (const ref of refs) {
      if (ref.threadId !== threadId) continue;
      if (match !== null) return null;
      match = ref;
    }
    if (match !== null) return match;
  }
  return null;
}

/**
 * A thread link whose label survives Markdown: no brackets, backslashes, or line breaks. Pass
 * `environmentId` for a link read outside the thread's own environment.
 */
export function formatThreadLink(threadId: string, label: string, environmentId?: string): string {
  const cleaned = label
    .replace(/[[\]\\\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const env =
    environmentId === undefined ? "" : `${ENVIRONMENT_QUERY}${encodeURIComponent(environmentId)}`;
  return `[${cleaned || threadId}](${THREAD_LINK_HREF_PREFIX}${threadId}${env})`;
}

export function hasThreadLinks(markdown: string): boolean {
  return markdown.includes(`](${THREAD_LINK_HREF_PREFIX}`);
}

export function relabelThreadLinks(
  markdown: string,
  title: (threadId: ThreadId) => string | undefined,
): string {
  if (!hasThreadLinks(markdown)) return markdown;
  return markdown.replace(THREAD_LINK_OUTSIDE_CODE, (source, ...args) => {
    const href = (args.at(-1) as { href?: string }).href;
    if (href === undefined) return source;
    const written = parseThreadLinkHref(href);
    if (written === null) return source;
    const decoded = percentDecodedThreadLinkId(written);
    const threadId =
      title(written) === undefined && decoded !== null && title(decoded) !== undefined
        ? decoded
        : written;
    const label = title(threadId)?.trim();
    const environmentId = parseThreadLinkEnvironmentId(href);
    return label ? formatThreadLink(threadId, label, environmentId ?? undefined) : source;
  });
}
