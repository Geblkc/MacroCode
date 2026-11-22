# Changelog

All notable changes to MacroCode are documented here.

## [1.0.0] — 2026-11-22

First stable release. Full notes: [`docs/releases/v1.0.0.md`](docs/releases/v1.0.0.md).

### Added
- 12 providers (Anthropic, OpenAI, Gemini, Ollama, OpenRouter, DeepSeek, xAI,
  MiniMax, Kimi, GLM, NVIDIA, EVREN) with live model discovery and models.dev
  metadata.
- Approval-first agent mode with workspace jail, blocked paths, MCP tools,
  sub-agents and plan/todo support.
- Project snapshots with safety restore, plus backup/undo for agent edits.
- Built-in Git panel and `/git` commands.
- Token/cost metering, prompt caching, context meter and auto-compaction.
- Five-language UI (en, tr, de, fr, es).

### Changed
- Agent backups are written with sanitized `.bak` names so project test/lint
  tools never pick them up.
- `.macrocode/` is ignored by git, ESLint, Prettier and Vitest.
- Linux packaging script (`scripts/build-linux.sh`) is restored and documented.
- Release notes are read from tracked `docs/releases/vX.Y.Z.md` files.

### Security
- API keys remain local in `keys.json` with `0600` permissions on Unix
  (plaintext at rest, not yet in the OS keychain).
- Signed updates, CSP hardening and approval-gated shell execution.

### Fixed
- Tauri IPC argument casing for stream/proxy commands.
- `apply_patch` failed on file names containing spaces or non-ASCII characters.
- CI formatting/lint regressions in Rust and TypeScript.
