import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";

import {
  injectHtmlRenderBootstrap,
  htmlArtifactDocument,
  htmlRenderThemeMessage,
  stripHtmlRenderBootstrap,
  readHtmlRenderImageRequest,
  readHtmlRenderLinkRequest,
} from "./htmlRender.ts";
import { htmlRenderFromToolItem } from "./toolOutput.ts";

const reference = { attachmentId: "thread-abc-123.html", title: "Chart", height: 420 };

describe("injectHtmlRenderBootstrap", () => {
  it("puts the theme ahead of the page's own head content", () => {
    const html =
      "<!doctype html><html><head><style>:root{--background:red}</style></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    const themeAt = injected.indexOf('<style id="t3-theme">');
    expect(themeAt).toBeGreaterThan(injected.indexOf("<head>"));
    expect(themeAt).toBeLessThan(injected.indexOf(":root{--background:red}"));
    expect(injected).toContain('<meta charset="utf-8">');
    expect(injected).toContain('name="viewport"');
  });

  it("wraps fragments without a head and keeps existing meta tags", () => {
    const fragment =
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><p>hi</p>';
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.match(/charset/g)).toHaveLength(1);
    expect(injected.match(/name="viewport"/g)).toHaveLength(1);
    expect(injected.endsWith("<p>hi</p>")).toBe(true);
  });

  it.each(["textarea", "iframe", "plaintext"])("keeps the bootstrap outside %s content", (tag) => {
    const fragment = `<${tag}><head><meta name="viewport"></head></${tag}>`;
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf(`<${tag}>`));
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
    expect(injected.endsWith(fragment)).toBe(true);
  });

  it.each([
    '<template><head><meta name="viewport"></head></template>',
    '<template><template>inner</template><head><meta name="viewport"></head></template>',
  ])("keeps the bootstrap outside inert template content: %s", (fragment) => {
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf("<template>"));
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
    expect(injected.endsWith(fragment)).toBe(true);
  });

  it("ignores tags written inside comments and scripts", () => {
    const html =
      '<!-- copy <head> and <meta name="viewport"> here --><html><head>' +
      "<script>const tag = '<meta name=\"viewport\">';</script></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    expect(injected.indexOf('<style id="t3-theme">')).toBeGreaterThan(
      injected.indexOf("<html><head>"),
    );
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
  });
});

describe("readHtmlRenderLinkRequest", () => {
  it("accepts only http(s) URLs in an MCP Apps ui/open-link request", () => {
    const link = (url: unknown, modifiers = {}) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/open-link",
      params: { url, ...modifiers },
    });
    expect(readHtmlRenderLinkRequest(link("https://example.com/a"))).toEqual({
      id: 1,
      url: "https://example.com/a",
      metaKey: false,
      ctrlKey: false,
    });
    expect(
      readHtmlRenderLinkRequest(link("https://example.com/a", { metaKey: true, ctrlKey: "yes" })),
    ).toEqual({ id: 1, url: "https://example.com/a", metaKey: true, ctrlKey: false });
    expect(readHtmlRenderLinkRequest(link("javascript:alert(1)"))).toBeUndefined();
    expect(readHtmlRenderLinkRequest(link("file:///etc/passwd"))).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({
        jsonrpc: "2.0",
        method: "ui/open-link",
        params: { url: "https://example.com" },
      }),
    ).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({ type: "t3-html-render-link", url: "https://example.com" }),
    ).toBeUndefined();
  });
});

describe("readHtmlRenderImageRequest", () => {
  it("accepts http(s) and inline image URLs in an open-image notification", () => {
    const image = (params: unknown) => ({
      jsonrpc: "2.0",
      method: "t3/notifications/open-image",
      params,
    });
    expect(
      readHtmlRenderImageRequest(image({ src: "data:image/png;base64,AA", name: " Chart " })),
    ).toEqual({
      src: "data:image/png;base64,AA",
      name: "Chart",
    });
    expect(readHtmlRenderImageRequest(image({ src: "https://example.com/a.png" }))).toEqual({
      src: "https://example.com/a.png",
      name: "Image",
    });
    expect(readHtmlRenderImageRequest(image({ src: "javascript:alert(1)" }))).toBeUndefined();
    expect(readHtmlRenderImageRequest(image({ src: "data:text/html,<p>" }))).toBeUndefined();
    expect(readHtmlRenderImageRequest(image({ src: "blob:null/1" }))).toBeUndefined();
  });
});

describe("htmlRenderFromToolItem", () => {
  const result = { htmlRender: reference, message: "Rendered above your reply." };

  it("reads the reference from each provider's result envelope", () => {
    for (const [toolName, output] of [
      ["mcp__t3-code__html_render", [{ type: "text", text: JSON.stringify(result) }]],
      ["t3-code.html_render", { structuredContent: result, content: [] }],
      ["t3-code-thread_1_html_render", JSON.stringify(result)],
      ["html_render", result],
    ] as const) {
      expect(htmlRenderFromToolItem({ toolName, output })).toEqual(reference);
    }
  });
});

describe("stripHtmlRenderBootstrap", () => {
  it("removes the host bridge while keeping the page's scripts", () => {
    const page =
      '<html><head></head><body><script>document.body.textContent = "ready"</script></body></html>';
    const result = stripHtmlRenderBootstrap(injectHtmlRenderBootstrap(page));
    expect(result).not.toContain("t3/notifications/shortcuts");
    expect(result).toContain('<script>document.body.textContent = "ready"</script>');
  });
});

it("removes versioned and legacy bootstraps independently of their source formatting", () => {
  const legacy = `<script>(function () { var s = document.getElementById('t3-theme');
      /* older release */ notify('ui/open-link'); notify('ui/notifications/host-context-changed'); })();</script>`;
  expect(stripHtmlRenderBootstrap(legacy)).toBe("");
  expect(
    stripHtmlRenderBootstrap('<script data-t3-html-render-bootstrap="2">different()</script>'),
  ).toBe("");
  const page = '<!-- <script>example</script> --><script>const text = "ui/open-link";</script>';
  expect(stripHtmlRenderBootstrap(page)).toBe(page);
});

describe("htmlArtifactDocument", () => {
  const theme = { appearance: "dark", variables: { "--background": "#123456" } } as const;

  it("permits HTTPS resources explicitly while denying unspecified resource types", () => {
    const html = htmlArtifactDocument("<p>Artifact</p>", theme);
    const policy = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
    if (!policy) throw new Error("Artifact resource policy is missing");
    const directives = new Map(
      policy.split(";").map((directive) => {
        const [name, ...sources] = directive.trim().split(/\s+/);
        return [name, sources];
      }),
    );
    for (const resource of ["script", "style", "img", "font", "connect"]) {
      expect(directives.get(`${resource}-src`), resource).toContain("https:");
    }
    expect(directives.get("default-src")).toEqual(["'none'"]);
    expect(directives.get("form-action")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["about:"]);
  });

  it("executes the preserved page script and consumes HTTPS data after removing the inline bridge", async () => {
    const html = htmlArtifactDocument(
      injectHtmlRenderBootstrap(`<html><head>
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
        <script src="https://cdn.example/chart.js"></script>
        </head><body><img src="https://cdn.example/chart.png"><script>
        globalThis.ready = fetch("https://data.example/chart.json")
          .then(response => response.json())
          .then(data => { document.body.textContent = data.title; });
        </script></body></html>`),
      theme,
    );
    const requests: string[] = [];
    const style = { textContent: "" };
    const body = { textContent: "" };
    const context = NodeVM.createContext({
      URL,
      window: { parent: {}, addEventListener: () => {} },
      document: {
        body,
        getElementById: () => style,
        addEventListener: () => {},
      },
      fetch: async (url: string) => {
        requests.push(url);
        return Response.json({ title: "Loaded chart" });
      },
    });
    for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (!/\bsrc=/.test(script[1] ?? "")) NodeVM.runInContext(script[2] ?? "", context);
    }
    await NodeVM.runInContext("ready", context);
    expect(requests).toEqual(["https://data.example/chart.json"]);
    expect(body.textContent).toBe("Loaded chart");
    expect(style.textContent).toContain("--background:#123456");
    expect(html).toContain('href="https://fonts.googleapis.com/css2?family=Inter"');
    expect(html).toContain('src="https://cdn.example/chart.js"');
    expect(html).toContain('src="https://cdn.example/chart.png"');
  });

  it("initializes the theme before page scripts without retaining host requests", () => {
    const html = htmlArtifactDocument(
      injectHtmlRenderBootstrap("<script>interactive()</script>"),
      theme,
    );
    expect(html).not.toContain("t3/notifications/shortcuts");
    expect(html).not.toContain("window.parent.postMessage");
    expect(html).toContain('<base href="about:blank">');
    expect(html.indexOf("apply(")).toBeLessThan(html.indexOf("interactive()"));
    expect(html).toContain("base-uri about:; form-action 'none'");
  });

  it("applies live parent themes and opens only ordinary web links without an opener", () => {
    const html = htmlArtifactDocument("<p>Artifact</p>", theme);
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    if (!script) throw new Error("Artifact bootstrap is missing");
    const style = { textContent: "", scrollIntoView: () => {} };
    const parent = {};
    const messages: Array<(event: unknown) => void> = [];
    const clicks: Array<(event: unknown) => void> = [];
    NodeVM.runInNewContext(script, {
      URL,
      window: {
        parent,
        addEventListener: (_name: string, listener: (event: unknown) => void) =>
          messages.push(listener),
      },
      document: {
        getElementById: () => style,
        addEventListener: (_name: string, listener: (event: unknown) => void) =>
          clicks.push(listener),
      },
    });
    expect(style.textContent).toContain("--background:#123456");
    const update = htmlRenderThemeMessage({
      appearance: "light",
      variables: { "--background": "#ffffff" },
    });
    messages[0]?.({ source: {}, data: update });
    expect(style.textContent).toContain("--background:#123456");
    messages[0]?.({ source: parent, data: update });
    expect(style.textContent).toContain("color-scheme:light");
    expect(style.textContent).toContain("--background:#ffffff");
    for (const href of [
      "https://example.com",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "/api/assets",
      "#section",
    ]) {
      const link = {
        matches: () => true,
        getAttribute: () => href,
        target: "",
        rel: "",
        removeAttribute: () => {},
      };
      let prevented = false;
      clicks[0]?.({
        composedPath: () => [link],
        preventDefault: () => {
          prevented = true;
        },
      });
      if (href === "https://example.com") {
        expect(prevented).toBe(false);
        expect(link.target).toBe("_blank");
        expect(link.rel).toBe("noopener noreferrer");
      } else {
        expect(prevented).toBe(true);
      }
    }
  });
});
