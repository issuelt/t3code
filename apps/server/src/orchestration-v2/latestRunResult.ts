const MAX_LAST_LINE_LENGTH = 280;
const FENCE = /^(`{3,}|~{3,})\S*$/;

export function lastReportLine(text: string): string | null {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line.length === 0 || FENCE.test(line)) continue;
    return line.length > MAX_LAST_LINE_LENGTH
      ? `${line.slice(0, MAX_LAST_LINE_LENGTH - 1)}…`
      : line;
  }
  return null;
}
