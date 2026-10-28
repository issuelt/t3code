export async function loadHtmlArtifact(
  url: string,
  signal: AbortSignal,
  reload = false,
): Promise<string> {
  const response = await fetch(url, {
    signal,
    cache: reload ? "reload" : "default",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    redirect: "error",
  });
  if (!response.ok) throw new Error("Could not load this page.");
  return response.text();
}
