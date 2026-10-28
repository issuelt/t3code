import { expect, it, vi } from "vite-plus/test";

import { loadHtmlArtifact } from "./htmlArtifact";

it("loads an authorized attachment without ambient credentials or redirects", async () => {
  const fetchArtifact = vi.fn(async () => new Response("<button>Interactive</button>"));
  using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(fetchArtifact);
  const controller = new AbortController();
  expect(
    await loadHtmlArtifact("https://environment.example/api/assets/signed", controller.signal),
  ).toBe("<button>Interactive</button>");
  expect(fetchArtifact).toHaveBeenCalledWith("https://environment.example/api/assets/signed", {
    signal: controller.signal,
    cache: "default",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    redirect: "error",
  });
});

it("rejects expired or unauthorized attachments instead of rendering the error response", async () => {
  using _fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("Unauthorized", { status: 401 }));
  await expect(
    loadHtmlArtifact(
      "https://environment.example/api/assets/expired",
      new AbortController().signal,
    ),
  ).rejects.toThrow("Could not load this page.");
});
