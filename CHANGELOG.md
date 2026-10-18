# Changelog

## v0.3.2 — unreleased development PR

- Add custom-exercise listing, duplicate-aware create/update previews and guarded commits with stable IDs.
- Add date-filtered cursor history, full supported workout detail and per-exercise history preserving repeated occurrences.
- Edit saved workouts in place: exercises, sets, order, name and session/occurrence notes, with volume/PR/held-weight previews.
- Extend historical logging and editing with seconds, warmup/work phases, actual left/right data, RIR/RPE and explicit as-recorded/per-bell/pair-total meanings. Preserve old numeric weights.
- Route every writer, including original plan/log tools, through mandatory private atomic backups (default 20), fresh revision/write-ID/content checks and one-shot submission. Distinguish confirmed, failed and uncertain outcomes.
- Add mocked safety/model tests and a read-only PR Docker context/build/runtime smoke job. Keep all original 24 tests; adapt only backup injection, tool counts and chronological lookup.
- Document the pinned openGym v1.4.1 contract, unsupported migrations/structures, manual recovery and separately authorized release/production procedures.

Version metadata and production image examples stay at 0.3.1 until formal release approval. No NAS deployment or GHCR release is performed by this PR.

## v0.3.1

Initial public Bridge release with 24 passing tests, guarded plan changes and historical workout logging.
