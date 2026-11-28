# Changelog

All notable changes to MacroCode are documented here.

## [1.2.0] — 2026-11-28

Full notes: [`docs/releases/v1.2.0.md`](docs/releases/v1.2.0.md).

### Changed
- `/mode`, `/build`, `/plan` and `/ask` are handled in the pure command layer
  with injected context; mode changes are locked while an approval is pending.
- Agent mode validation is centralized; unknown persisted modes fall back to
  `plan` instead of enabling the full Build tool set. Tool lists are derived
  from a single source.

### Fixed
- Restored runs keep their original mode and approvals are re-checked against
  mode restrictions before execution.
- Subagents are genuinely read-only (ask-filtered tools, dedicated prompt,
  deny list including snapshot/plan/todo).
- Plan step IDs derive from the tool call ID, preventing wrong todo completion
  after a second plan call or a restart.

## [1.1.0] — 2026-11-27

Full notes: [`docs/releases/v1.1.0.md`](docs/releases/v1.1.0.md).

### Added
- Session history: archive/restore/permanent-delete with a searchable dialog;
  archived sessions stay out of the sidebar and navigation.
- Parallel conversations: per-session streaming state and abort controllers.
- `/perf [on|off|reset]` report and terminal render metrics; opt-in
  `content-visibility` experiment for long terminal views.

### Changed
- Streaming deltas are batched (40 ms), session persistence to localStorage is
  deferred, and timeline/view-line caches plus narrow store subscriptions keep
  the UI responsive during long answers.
- Rust: blocking work moved to `spawn_blocking`, exec capture capped at 1 MiB
  per stream, HTTP clients reused, keychain reads parallelized, release builds
  use thin LTO and symbol stripping.

### Security
- Fixed workspace escape via predictable patch temp files (B1), unvalidated
  exec file arguments including `eslint`/`tsc` (B2), IPv6 SSRF bypass (B3),
  Git remote/branch option injection (B4) and snapshot manifest path
  traversal (B6).

### Fixed
- Aborting or showing the typing indicator in one conversation no longer
  affects a different streaming session.

## [1.0.1] — 2026-11-23

Maintenance release: repository URLs, badges and the in-app updater now point
to `Geblkc/MacroCode`. Full notes:
[`docs/releases/v1.0.1.md`](docs/releases/v1.0.1.md).

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
- API keys are stored in the OS keychain (Windows Credential Manager, macOS
  Keychain, Linux Secret Service); plaintext `keys.json` values are migrated on
  first launch and the file is deleted. A `0600` local file remains as fallback
  when no keychain is reachable.
- Signed updates, CSP hardening and approval-gated shell execution.

### Fixed
- Tauri IPC argument casing for stream/proxy commands.
- `apply_patch` failed on file names containing spaces or non-ASCII characters.
- CI formatting/lint regressions in Rust and TypeScript.
