const MAX_CONTEXT_SHARE = 0.5;

export function homeContextHalfFull(input: {
  readonly usedTokens: number | undefined;
  readonly contextWindow: number | undefined;
}): boolean {
  return (
    input.usedTokens !== undefined &&
    input.contextWindow !== undefined &&
    input.contextWindow > 0 &&
    input.usedTokens >= input.contextWindow * MAX_CONTEXT_SHARE
  );
}
