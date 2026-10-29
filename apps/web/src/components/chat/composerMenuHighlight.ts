export function nudgeComposerMenuItemId(input: {
  items: ReadonlyArray<{ id: string }>;
  highlightedItemId: string | null;
  key: "ArrowDown" | "ArrowUp";
}): string | null {
  if (input.items.length === 0) return null;
  const highlightedIndex = input.items.findIndex((item) => item.id === input.highlightedItemId);
  const normalizedIndex =
    highlightedIndex >= 0 ? highlightedIndex : input.key === "ArrowDown" ? -1 : 0;
  const offset = input.key === "ArrowDown" ? 1 : -1;
  const nextIndex = (normalizedIndex + offset + input.items.length) % input.items.length;
  return input.items[nextIndex]?.id ?? null;
}

export function resolveComposerMenuActiveItemId(input: {
  items: ReadonlyArray<{ id: string }>;
  highlightedItemId: string | null;
  currentSearchKey: string | null;
  highlightedSearchKey: string | null;
}): string | null {
  if (input.items.length === 0) {
    return null;
  }

  if (
    input.currentSearchKey === input.highlightedSearchKey &&
    input.highlightedItemId &&
    input.items.some((item) => item.id === input.highlightedItemId)
  ) {
    return input.highlightedItemId;
  }

  return input.items[0]?.id ?? null;
}
