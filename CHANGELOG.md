# Changelog

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
