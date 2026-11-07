// @effect-diagnostics nodeBuiltinImport:off -- The fixture runs a child process against temporary Codex configuration.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

it("reads the selected provider and auth beside the explicit config", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "eval-proxy-"));
  try {
    const config = NodePath.join(dir, "config.toml");
    NodeFS.writeFileSync(
      config,
      '[model_providers.fixture]\nbase_url = "http://localhost:1234/v1/"\nrequires_openai_auth = true\n',
    );
    NodeFS.writeFileSync(
      NodePath.join(dir, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "fixture-only" }),
    );
    const result = NodeChildProcess.execFileSync(
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
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});
