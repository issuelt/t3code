// @effect-diagnostics-next-line nodeBuiltinImport:off -- reads repo files synchronously to cross-check literals.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  CLI_RELEASES_PAGE_URL,
  cliReleaseDownloadBaseUrl,
  cliReleaseIndexPageUrl,
} from "./cliRelease.ts";
import { FORK_RELEASES_URL, FORK_REPOSITORY } from "./fork.ts";

const repoFile = (path: string) =>
  NodeFS.readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

// Upstream syncs have reverted the release source to pingdotgg/t3code before.
describe("fork release source", () => {
  it("serves CLI updates and downloads from the fork", () => {
    expect(CLI_RELEASES_PAGE_URL).toBe(FORK_RELEASES_URL);
    expect(cliReleaseDownloadBaseUrl("1.2.3")).toBe(`${FORK_RELEASES_URL}/download/v1.2.3`);
    expect(cliReleaseIndexPageUrl(1)).toBe(
      `https://api.github.com/repos/${FORK_REPOSITORY}/releases?per_page=100&page=1`,
    );
  });

  it.each([
    ["scripts/install.sh", /^repo="([^"]+)"$/m],
    ["scripts/install.ps1", /^\$repo = "([^"]+)"$/m],
  ])("installs from the fork in %s", (path, repoLiteral) => {
    expect(repoLiteral.exec(repoFile(path))?.[1]).toBe(FORK_REPOSITORY);
  });

  it.each([
    "apps/desktop/src/app/DesktopStartupRecovery.ts",
    "apps/web/src/components/desktopUpdate.logic.ts",
  ])("takes desktop release links from the fork module in %s", (path) => {
    const source = repoFile(path);
    expect(source).toContain('from "@t3tools/shared/fork"');
    expect(source).not.toContain("pingdotgg/t3code");
  });
});
