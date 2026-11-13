const MAX_CONTEXT_SHARE = 0.5;

export function homeContextFull(input: {
  readonly usedTokens: number | undefined;
  readonly contextWindow: number | undefined;
  readonly autoCompactThreshold: number | undefined;
}): boolean {
  if (input.usedTokens === undefined) return false;
  const usedTokens = input.usedTokens;
  const limits = [
    input.contextWindow !== undefined && input.contextWindow > 0
      ? input.contextWindow * MAX_CONTEXT_SHARE
      : undefined,
    input.autoCompactThreshold,
  ];
  return limits.some((limit) => limit !== undefined && usedTokens >= limit);
}
