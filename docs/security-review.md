# Development security review — 2026-10-18

Scope: the fresh development checkout, its Git history, synthetic tests and CI configuration. Production NAS, credentials, persistent user data and Tunnel configuration are outside scope and were not accessed.

- Baseline: the original 24 tests passed before implementation. Final local suite: **86 tests passed, 0 failed, 0 skipped** (Node.js 24.19.0). All original test names remain; adaptations inject a fake backup, account for added tools and locate chronological records by date rather than append position.
- Seven additional local synthetic scenarios passed against the pinned official server sync-stamp module, kept outside the public checkout. This checks server mutation compatibility, not live device synchronization.
- Gitleaks 8.30.1 found no secrets in the working source tree or fetched Git history. Manual review checked fixture provenance, domains/IP literals, configuration examples, ignored paths and the proposed publication file list. These checks are evidence for this change, not a guarantee about arbitrary future commits.
- `git diff --check` and actionlint 1.7.12 passed. No new npm dependencies were introduced. Existing SHA-pinned Actions and GITHUB_TOKEN publication remain in place.
- Only `.env.example`, `docker-compose.example.yaml` and `tunnel-client.example.yaml` are versioned configuration examples. Local `.env`, secrets/store, Compose/Tunnel configuration and backups remain ignored. Docker uses a runtime allowlist that excludes tests and local data.
- PR CI runs tests, injects synthetic build-context canaries, audits the exported context, builds linux/amd64 and initializes MCP with container networking disabled. PR jobs have only contents-read permission and cannot publish GHCR images. Only the existing non-PR publishing job receives packages-write permission.
- Every writer checks the current revision/write ID/content, requires a private atomic pre-write backup, sends one versioned PUT without `stamped: true`, consumes the proposal before submission and rereads. Conflicts do not retry; uncertain results remain pending. HTTP/network/backup errors do not echo raw credential-bearing responses.
- Query outputs whitelist training fields and bound serialized results. Notes/descriptions remain untrusted content. No media upload, custom deletion, automatic restore, date migration or production auto-updater is added.

Remaining acceptance work before production: review/approve this PR, pass its GitHub test/build jobs, perform disposable-account Android/web synchronization checks, then separately approve formal versioning/release and any NAS upgrade. See [operations](operations.md) and [compatibility limits](compatibility.md). This PR deliberately leaves package/image release pins at 0.3.1.
