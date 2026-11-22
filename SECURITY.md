# Security Policy

MacroCode is a local-first, bring-your-own-key (BYOK) desktop application. It has
no account system, no backend and no telemetry. Security reports are taken
seriously — thank you for helping keep users safe.

## Supported versions

Security fixes are shipped for the **latest released version** only. Please
reproduce issues on the newest release before reporting.

| Version | Supported |
|---|---|
| Latest `1.x` release | ✅ |
| Older releases | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private reporting flow:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** (GitHub Security Advisories).
3. Include: affected version, OS, reproduction steps, and impact assessment.

If GitHub private reporting is unavailable, open a minimal public issue asking
for a private channel — do not include exploit details.

### What to expect

- **Acknowledgement:** best effort within 72 hours.
- **Assessment:** initial severity/triage within 7 days.
- **Fix & disclosure:** coordinated. We will credit you in the advisory unless
  you ask to remain anonymous.
- This is a volunteer-maintained project; timelines are best effort, not a
  commercial SLA.

## In scope

- Remote code execution, sandbox/workspace-jail escapes (`src-tauri/src/commands/`)
- Path traversal or symlink escapes in `fs`, `patch`, `exec` and `git` commands
- Command injection through shell, Git, MCP stdio or provider requests
- API-key disclosure (storage, logs, exports, crash output)
- XSS/HTML injection in the markdown renderer or tool output
- CSP/capability bypasses in the Tauri shell
- Supply-chain issues in shipped dependencies

## Out of scope

- Vulnerabilities in third-party AI providers or their APIs
- Issues requiring an already-compromised OS account with access to the user's
  app-data directory
- Denial of service through intentionally huge local files (report if it causes
  silent data loss)
- Social engineering, spam, or missing security headers on external sites
- Reports produced solely by automated scanners without a concrete impact path

## Security model (summary)

| Area | Design |
|---|---|
| API keys | Stored in the OS keychain (Windows Credential Manager, macOS Keychain, Linux Secret Service). On first launch, legacy plaintext `keys.json` values are migrated and the file is deleted. If no keychain is reachable, keys fall back to `keys.json` with mode `0600` on Unix. Keys are never sent anywhere except the configured provider as auth headers. |
| Sessions | Local SQLite database; no server-side storage. |
| Network | CSP restricts connections; custom endpoints/MCP requests go through the Rust proxy. |
| Agent tools | Approval-first writes/execs, workspace root jail, blocked/secret path lists, `rm` restricted, system directories denied. |
| Git | `git` CLI without a shell, repo must equal workspace root, pathspecs after `--`, auth prompts disabled. |
| Updates | Tauri updater signatures verified against the bundled public key. |

### Key storage details

- The keychain is authoritative. Writes go to the keychain first; a successful
  write removes any stale plaintext copy from `keys.json`.
- Migration is idempotent: entries that cannot be moved stay in the local file
  and are retried on the next launch, so a temporarily unavailable keychain
  never loses keys.
- **Fallback limitation:** on a system with no reachable keychain (for example
  headless Linux without a Secret Service), keys are still stored in plaintext
  in the app-data file, protected only by Unix `0600` permissions. Enable disk
  encryption and keep the app-data directory out of cloud sync in that case.
- Exports, logs, audit records and tool output redact key/token patterns; the
  frontend receives one provider's key at a time, never a bulk dump.

The Git-specific threat model is documented in [`docs/GIT.md`](docs/GIT.md).

## Safe harbor

Good-faith research that respects user data, avoids service disruption and
follows this policy will not be pursued legally. Test only against your own
installation and data.

---

## Türkçe özet

Güvenlik açıklarını **lütfen herkese açık issue olarak açmayın**. Depodaki
**Security → Report a vulnerability** akışını kullanın. En güncel sürüm
desteklenir; ilk yanıt hedefi 72 saat, triyaj hedefi 7 gündür. Kapsam: workspace
jail kaçışları, komut enjeksiyonu, API anahtarı ifşası, markdown XSS, Tauri
CSP/capability bypass'ları ve tedarik zinciri. Üçüncü taraf sağlayıcıların kendi
API'lerindeki sorunlar kapsam dışıdır.
