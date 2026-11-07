import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("reads the selected provider and auth beside the explicit config", () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-proxy-"));
  try {
    const config = join(dir, "config.toml");
    writeFileSync(
      config,
      '[model_providers.fixture]\nbase_url = "http://localhost:1234/v1/"\nrequires_openai_auth = true\n',
    );
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "fixture-only" }));
    const result = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { proxyConfig } from "./proxy.ts"; console.log(JSON.stringify(proxyConfig()));',
      ],
      {
        cwd: import.meta.dirname,
        env: { ...process.env, EVAL_CODEX_CONFIG: config, EVAL_CODEX_PROVIDER: "fixture" },
        encoding: "utf8",
      },
    );
    expect(JSON.parse(result)).toEqual({
      url: "http://localhost:1234/v1",
      headers: { Authorization: "Bearer fixture-only" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
