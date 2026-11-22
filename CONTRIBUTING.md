# CONTRIBUTING — MacroCode

Thanks for helping improve MacroCode. This document describes the local
workflow, test commands and coding conventions. Türkçe sürüm:
[`CONTRIBUTINGtr.md`](CONTRIBUTINGtr.md).

## Setup

```bash
npm install
npm run build     # tsc + vite
npm test          # unit tests
```

`tauri dev` / `tauri build` additionally needs Rust stable and the platform
system dependencies listed in [`README.md`](README.md).

## Test commands

```bash
npm test                  # vitest, single run
npx tsc --noEmit          # type-check
npm run build             # production build (smoke)
npm run lint              # eslint
npm run format:check      # prettier
npm run check:secrets     # secret/API-key scan of tracked files
cargo test --lib          # Rust unit tests (from src-tauri/)
cargo fmt --check
cargo clippy --lib -- -D warnings
```

## Definition of done

A change is complete only when:

1. All checks are green (`npm test`, `npm run lint`, `npm run format:check`,
   `npm run check:secrets`, `cargo fmt --check`,
   `cargo clippy --lib -- -D warnings`, `cargo test --lib`).
2. The acceptance criteria for the change are met.
3. `docs/ARCHITECTURE.md` reflects architectural changes and `docs/DEVLOG.md`
   has a dated entry. Do not bump the version unless the release is intentional.

## Changing the exec allowlist

`src/lib/engine/allowlist.json` is the single source of truth:

1. Change **only** `allowlist.json` (the `rm` rule is fixed and cannot be extended).
2. Update/run the drift test in `src/lib/engine/policy.test.ts`.
3. Update/run the Rust tests in `src-tauri/src/commands/exec.rs`.
4. `exec` always requires manual approval (O6) — `autoApproved` must never be `true`.

## Conventions

- **UI strings live in `src/lib/i18n/locales/`** — do not hard-code Turkish text
  in components. `tr.ts` is the source of truth; every new key must be added to
  all five dictionaries (`tr/en/de/fr/es`). Use `useT()` in React and `t()` from
  `lib/i18n/core` elsewhere.
- **Model-facing text** (`toolspec.ts` tool descriptions) is English and fixed.
- Keep comments short; use the CSS tokens in `styles/global.css` instead of
  adding new colors.
- A `Message`/`Session` schema change requires a `normalizeSession` round-trip test.
- A new invoke command requires `mod.rs` + `lib.rs` registration and a Rust test.
- Never write agent artifacts into tracked source paths. `.macrocode/` is
  ignored by git, ESLint, Prettier and Vitest.
