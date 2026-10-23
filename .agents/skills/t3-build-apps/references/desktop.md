# Desktop builds (mac / win / linux)

`node scripts/build-desktop-artifact.ts` builds all three; the `dist:desktop:*`
npm scripts wrap it. Artifacts land in `release/`. `--skip-build` reuses an
existing dist; `--keep-stage` keeps the /tmp stage for inspection.

## First-time setup

- **Toolchain:** Node via `vp` (`~/.vite-plus/bin` first on PATH), pnpm 11.
  `vp` lives in `node_modules/.bin` — add it to PATH or use `npx vp`.
- **Mac:** Xcode command-line tools for codesign; a login/GUI session for a
  truthful health check.
- **Windows cross-build on Linux:** `nix profile add nixpkgs#wine` (wine 11
  works). node-pty's gyp step needs a `nix-shell -p python3 gcc gnumake`. On
  NixOS use `/run/wrappers/bin/sudo` if a stage cleanup needs root.
- If a staged `vp install --prod` fails on a broken electron package, run
  `pnpm store prune` and retry.

## Gotchas that cost hours (Mac)

- macOS temp is `/var/folders/xx/yy/T/`, NOT `/tmp`; the stage lives there at
  depth ~5 — `find -maxdepth 4` misses it.
- Paths have spaces/parens (`T3 Code (Alpha).app`) — use `find`/quotes, not globs.
- Write Mac scripts to a file and `scp` them; don't nest heredocs (quoting trap).
- **HEALTH=000 over SSH is a FALSE negative.** A headless launch hits Keychain
  `errKCInteractionNotAllowed`; the app is fine if stderr shows `backend ready`
  - `main window created`. Verify a real 200 via `open` in your login session.

## Windows / Linux notes

- Cross-built win packages lack the WSL node-pty prebuild → WSL backend won't
  start; supply `--wsl-prebuild <pty.node>` for the target arch, or rely on the
  native backend + remote envs.
- Linux: `pnpm dist:desktop:linux` (AppImage, x64).

## Rust toolchain (required since upstream ~2026-08, resource monitor)

Desktop builds compile a native resource-monitor executable via `cargo build`
(`native/resource-monitor/Cargo.toml`). Without cargo on PATH the build dies
with `spawn cargo ENOENT`. One-time setup on the build Mac:

```bash
brew install rust   # provides cargo; rustup also works if you prefer toolchains
```
