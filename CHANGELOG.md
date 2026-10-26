# Changelog

## v0.4.1 — development, unreleased

- Pin text catalogue import to official openGym v1.4.2 commit `e9a303877d02e4237b183f96a9a6603990e8fafb`, verify all three source file digests, merge the independent muscle map and retain explicit zero weights and Chinese names. Fetch/schema/integrity failures preserve the existing catalogue; legacy readers remain compatible.
- Add `effective_sets`, muscle-weight source accounting and catalogue provenance to weekly analysis without removing legacy credit/volume/trend fields. Explicit valid historical snapshot weights win; missing weights use current official/custom metadata and documented defaults. Never rewrite history for a statistics refresh.
- Read optional substitutes and warmup/side rest settings in plans/saved targets; preserve root bar defaults and progress photo references. Refuse different-exercise replacement when exercise-specific settings cannot safely migrate.
- Retain all 37 tools and the existing auth, preview/confirmation, backup, revision/write-ID checks, single CAS PUT, reread and uncertain-write recovery implementations. Add pinned v1.4.2/v1.4.1 real-API/frontend compatibility CI, full-catalogue weight parity and successful calls to all tools.
- Update development metadata to 0.4.1. No tag, Release, production image publication, data migration, NAS or Tunnel change is part of this PR. See [compatibility semantics and test results](docs/v0.4.1.md).

## v0.4.0 — 2026-10-21 (skip v0.3.3)

- Edit existing routine names, exercises/order and training targets through guarded plan previews.
- Persist account-scoped workout drafts, measured sets, corrections and cancellation; finish through one human-approved backed-up CAS commit.
- Journal pending submissions durably before PUT and recover by exact read-only verification across restarts.
- Add recorded exercise progression, weekly volume/muscle credits and explicitly private bodyweight/feedback capture.
- Enforce published MCP input schemas, account isolation, private atomic files, conflict/timeout tests and full legacy regression.
- Link drafts to exact existing A/B/C routine IDs, preserve those IDs in completed history, and respect official deletion/Undo stamps in statistics and recovery.
- Pass all 155 regression tests and 15 isolated acceptance groups against pinned official openGym v1.4.1, including real API and frontend sync-store integration. Gate image builds on both suites.
- Publish versioned `0.4.0` and stable `latest` images for linux/amd64, with anonymous pull, digest, architecture and runtime-version verification. Production upgrades remain separately authorized.

Known acceptance gaps: real browser/PWA behavior and Android devices have not been validated. Bodyweight and feedback capture stays private to the Bridge. See [feature/safety notes](docs/v0.4.0.md) and the [dated acceptance report](docs/acceptance-v0.4.0.md).


## v0.3.2 — 2026-10-19

- Add custom-exercise listing, duplicate-aware create/update previews and guarded commits with stable IDs.
- Add date-filtered cursor history, full supported workout detail and per-exercise history preserving repeated occurrences.
- Edit saved workouts in place: exercises, sets, order, name and session/occurrence notes, with volume/PR/held-weight previews.
- Extend historical logging and editing with seconds, warmup/work phases, actual left/right data, RIR/RPE and explicit as-recorded/per-bell/pair-total meanings. Preserve old numeric weights.
- Reject ambiguous mixed bilateral/unilateral per-bell occurrences and any saved occurrence without a completed set/limb during preview, including add/replace and final edits; keep valid unchecked rows and separate explicit occurrences.
- Route every writer, including original plan/log tools, through mandatory private atomic backups (default 20), fresh revision/write-ID/content checks and one-shot submission. Distinguish confirmed, failed and uncertain outcomes.
- Add mocked safety/model tests and a read-only PR Docker context/build/runtime smoke job. Keep all original 24 tests; adapt only backup injection, tool counts and chronological lookup.
- Document the pinned openGym v1.4.1 contract, unsupported migrations/structures, manual recovery and separately authorized release/production procedures.

Release metadata and image examples are updated to 0.3.2. The release workflow publishes `0.3.2` and `latest` for linux/amd64 after tests and isolated runtime checks pass. Production upgrades remain separately authorized; existing 0.3.1 deployments are unchanged.

## v0.3.1

Initial public Bridge release with 24 passing tests, guarded plan changes and historical workout logging.
