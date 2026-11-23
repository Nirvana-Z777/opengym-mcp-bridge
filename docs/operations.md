# Backups, catalogue maintenance and deployment

The published release and Compose example currently use `ghcr.io/nirvana-z777/opengym-mcp-bridge:0.5.0`. This branch develops v0.5.1. Keep the published image pin at 0.5.0 until v0.5.1 has passed review, been merged and released. Development work does not update a NAS deployment or publish a release image. The `tunnel-client` is an independent component and its image is outside this Bridge release.

## Guarded openGym writes

Every upstream writer, including draft completion and body-data synchronization, uses the same guard. After an exact preview and explicit confirmation, the Bridge checks the current revision, write ID and state fingerprint, creates a private backup, sends at most one PUT, and reads the result back. A backup failure prevents the PUT. A 409 or uncertain response must be investigated with read-only queries. Never retry a consumed proposal.

Catalogue replacement and upstream writes share one in-process coordination lock. An overlapping operation is rejected before it can replace the catalogue, create a write backup or send a PUT. Configure one Bridge writer for each shared local store. The coordination lock is process-local, so running two Bridge processes against the same store is unsupported.

## Catalogue refresh in v0.5.1

The Bridge's official exercise catalogue is a local metadata copy. It does not reside in the openGym account. Refreshing it does not edit training history, drafts, questionnaires, feedback, body data, pairing credentials or MCP access credentials.

Use the MCP workflow for routine updates:

1. Call `get_catalogue_status` and review the current source, version, commit and exercise count.
2. Call `preview_catalogue_refresh`. Review the pinned candidate, source digests and samples of added, removed, renamed and remapped exercises.
3. After reviewing that specific preview, explicitly approve it and call `apply_catalogue_refresh` with its `proposal_id` and `confirmation: "我确认写入"`.
4. Read `get_catalogue_status` again and confirm the expected source version, commit and count.

The Bridge rechecks the preview's current-catalogue fingerprint and candidate digest while holding the shared lock. It validates every downloaded source before touching the local catalogue, writes a private backup of the existing catalogue and atomically replaces the file. A successful change advances the catalogue generation and expires all earlier upstream write previews, including draft completion, with its draft revision and submission metadata held in the same proposal. Each preview captures the current generation before awaiting any data. If the generation changes before a preview is registered, the Bridge rejects it as expired. The commit checks invalidation before creating an openGym backup or sending a PUT.

Overlap, stale fingerprints, download, digest or schema errors, and backup or rename failures prevent replacement. If there is a stale fingerprint, the Bridge preserves the file it found instead of overwriting the concurrent change. They do not send an openGym PUT. If the catalogue did not successfully change, the Bridge does not expire otherwise valid upstream previews solely because an attempted refresh failed. Check the returned error, preserve the logs, and retry only after the underlying cause has been resolved and a new refresh preview is generated.

### CLI maintenance fallback and recovery

The CLI importer is a maintenance fallback. Stop the Bridge container before running it because the CLI cannot coordinate with the running Bridge's in-process lock. Keep the existing local catalogue and its backup private. The command is `node src/catalogue.mjs` inside the Bridge source/container with the same intended environment. It imports only pinned official text metadata and does not download exercise media.

If a refresh needs rollback, stop the Bridge first. Identify the exact catalogue backup created by that refresh and check its source and contents privately. Restore only that catalogue file through a temporary file in the same directory, flush it, then atomically rename it over `exercise-names.json`. Do not copy the entire `store/` directory or overwrite credentials, drafts, feedback or backups. Restart one Bridge process and verify `get_catalogue_status` and a read-only exercise query before enabling writes. If atomic restoration fails, keep the Bridge stopped and preserve both the current file and selected backup for diagnosis.

If refresh reports an occupied lock after the operation has ended or warns that lock cleanup failed, stop the Bridge and verify no other process is updating the catalogue. Remove only the abandoned empty `<catalogue-file>.refresh-lock` directory before retrying. Keep any catalogue backup.

Historical explicit muscle snapshots remain authoritative for analysis. A catalogue refresh changes metadata used for new projections but does not migrate or rewrite old training records.

## Common workflows introduced in v0.5.0

| Task | Tool sequence |
| --- | --- |
| Plan and record a workout | `get_today_plan` with an IANA time zone → `preview_planned_session` → `start_planned_workout` → record actual sets and manage the clock with `draft_session_clock`. End the clock before previewing or confirming draft completion. |
| Read or synchronize native body data | Use `get_native_body_data` with a date range. Review `preview_body_sync` with new readings or selected private record IDs. Use `apply_body_sync` after exact confirmation. |
| Keep feedback in the Bridge | Use `record_session_feedback` for questionnaires and individual exercises, or `record_body_feedback` for private body feedback. Read back with the corresponding list tool. |
| Review suggestions or trends | `get_training_suggestion` reads the latest evidence. Select a suggestion with `preview_training_suggestion` and review the resulting plan proposal before using `apply_plan_change`. Use `get_training_trend` to read the series and SVG for a date range. |

See [example calls](v0.5.0.md#工具及调用示例).

## Local data and mandatory backups

The existing Compose mount stores local files under `/store/`. OpenGym write backups normally live in `/store/backups/`; private drafts and feedback remain under `/store/local/`. Keep `store/` and `secrets/` access restricted and include them in the owner's private backup routine. They contain account data and credentials. Never attach them to a public issue or add them to Git.

The backup store writes restricted files through a temporary file and atomic rename. Only Bridge backup files participate in retention. Backups contain pre-edit training state and revision metadata, but not authentication response envelopes. A credential-like value inside a state causes backup refusal. There is no automatic restore writer.

### Manual recovery of an upstream write

Recovery is a deliberate data change. Inspect a selected private backup offline, then read the latest live state and account for newer sessions, notes and device changes. Prefer a narrowly previewed inverse edit. If a whole-state repair is unavoidable, prepare a reviewed payload from the latest state and preserve current synchronization markers and unknown fields. Use only the latest read's `baseRev` and `baseWid`, make a new restricted backup, submit once and read back the result. Stop and rebuild the preview if the live state changes. Never force a 409 or retry an uncertain submission.

## Release procedure

For v0.5.1, the published Compose image remains 0.5.0 during development. The release flow is:

1. Align `package.json`, lock metadata and MCP initialization version to 0.5.1. Keep README and Compose references to 0.5.0 until release publication.
2. Run the complete regression suite, pinned official v1.4.1, v1.4.2 and v1.4.5 compatibility jobs, security/context checks and isolated Docker build/runtime checks on the reviewed PR head.
3. After the PR is approved and merged, wait for the `main` workflow to pass.
4. Only after separate release approval, create the matching `v0.5.1` tag. The workflow publishes `0.5.1` and `latest` for `linux/amd64` with GitHub's `GITHUB_TOKEN`. It checks tag/package version parity and image initialization. Confirm the release digest and anonymous pulls before announcing availability.
5. Confirm the GHCR package is Public. If GitHub created it as private, change visibility in the package settings, then verify an anonymous pull with an empty Docker credential directory.

The workflow does not need a PAT, openGym token, MCP token or runtime API key. Pull requests build temporary images without package-write permission. A successful merge or release does not itself authorize a production NAS upgrade.

## NAS upgrade and rollback

Production upgrade is a separate owner action after the release exists. Before upgrading, privately record the current image tag or digest and back up the deployment configuration, `store/` and `secrets/`. Pull the approved immutable Bridge image and recreate only the Bridge service. Keep openGym and tunnel-client running. Check MCP initialization, all expected tools, catalogue status and read-only queries first. Enable writes only after confirming the deployment and using the normal preview/backup/readback flow.

If the update fails, stop the Bridge, restore the prior known-good Bridge image pin and restart only that service. Keep the current private store. Restore a catalogue backup only when a catalogue change is the issue, using the atomic single-file procedure above. Code rollback does not undo an openGym write already accepted by the server. Investigate those records read-only and use the reviewed recovery process if a repair is needed.
