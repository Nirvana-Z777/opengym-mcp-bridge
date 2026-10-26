# Backup, release and deployment procedure

The published release remains `ghcr.io/nirvana-z777/opengym-mcp-bridge:0.4.0`. This branch has development package metadata **0.4.1**, but the README/Compose deployment pin stays at the published 0.4.0 until a separately approved release. PR development and CI do not change production NAS/container/Tunnel configuration or publish packages.

## Mandatory local backups

Every upstream writer, including draft completion, shares the same guard. Successful preview and human confirmation are followed by a fresh revision/write-ID/content check, then a mandatory backup, then at most one PUT. Backup failure means no PUT. There is no opt-out setting. Local drafts/feedback are separately durable under `/store/local/` and should be retained with `/store/backups/`.

## Optional catalogue refresh for v0.4.1

The maintenance importer reads only three text/JSON files from the fixed official v1.4.2 commit: EXDB, the independent muscle map and Chinese names. Each file's SHA-256 and parsed shape must match before an atomic replacement; HTTP, transport, digest or parse failures keep the old catalogue. It downloads no media, touches no openGym state and performs no history migration. Existing format-2 and names-only files remain readable. They do not automatically acquire the v1.4.2 row corrections: a separately authorized operator must refresh the optional text catalogue using `node src/catalogue.mjs` in the intended Bridge environment.

Record the existing catalogue source and retain a private copy before that maintenance. Keep writes off and discard old preview IDs around a refresh; new previews should use the new metadata consistently. Verify `source_version`, `source_commit` and `source_digests` in the local catalogue, and the returned weekly `muscle_weight_catalogue`. Historical explicit weight snapshots remain authoritative even when the refreshed catalogue differs. No production refresh is performed by this PR.

Default location is `backups/` beside `CATALOGUE_NAMES_FILE`: with the existing Compose `/store/exercise-names.json`, it is `/store/backups/` inside the container, using the existing `./store:/store` mount. Optional `OPENGYM_BACKUP_DIR` selects a dedicated backup directory; `OPENGYM_BACKUP_KEEP` is 1–100, default 20. Configure environment variables directly on the Bridge only if deviating from defaults. The sample Compose does not need a new mount or port.

The directory is checked against symlinks, created/restricted to 0700; files use 0600. A uniquely named temporary file is written and fsynced before atomic rename. Only regular files matching the Bridge's precise backup filename format participate in retention; unrelated files, directories and symlinks are left alone. Pruning failures also refuse the write. Backups store the pre-edit training state, source revision/write ID, timestamp and operation type. They exclude authentication response envelopes; credential-like keys inside state cause refusal rather than writing credentials into a backup.

Backups necessarily contain private training data. Keep the mounted directory restricted and backed up through your normal private backup process. They are ignored by Git and excluded from Docker build context. MCP returns only backup ID, timestamp, source revision and retention limit. It does not return file content or expose a restore tool. Do not attach a backup to a public issue.

## Manual recovery with revision control

Recovery is an intentional data change and requires the owner's approval. Do this on a disposable account first. Do not copy old `_rev`/`_wid` into a blind PUT or replace the live data directory.

1. With writes disabled, inspect the selected private backup offline. Verify its format, timestamp, operation and source revision; identify the specific changes that need recovery. Save a private current-state snapshot too. Do not paste either snapshot into public tickets or chat.
2. Read the latest live state through authenticated `/api/data` using the existing secure credential mechanism. Compare the selected backup with that state, accounting for all newer sessions/notes/device changes. Prefer a selective, previewed inverse edit through supported Bridge tools rather than restoring an old whole profile.
3. If whole-state recovery is necessary, prepare a reviewed recovery payload from the latest state and the explicitly approved recovered fields. Retain current sync records/unknown fields, do not use `stamped: true`, and submit only with **the latest read's** `baseRev` and `baseWid`. Take a new restricted atomic backup immediately before submitting. If the latest state changed, stop and rebuild the recovery preview; never force or retry a 409. This release provides no automatic recovery writer.
4. Submit once, then reread and compare the intended content. On timeout or failed reread, use read-only checks first. Reconcile a disposable Android/web client to check restored data and preserved later records before authorizing production use. Stop if the required merge, timestamps or tombstones cannot be established safely.

## Release procedure

After the owner approves the PR and formal release:

1. On the development branch, align package/lock metadata and README/Compose release pins to the approved target version (0.4.1 for the next release). Check MCP initialization derives that version from the package. Do not claim an unpublished image is available.
2. Pass the complete regression suite, both pinned official compatibility jobs, security/context checks and isolated Docker runtime smoke test on the final PR head. Only then merge the approved PR; main publishes its development `main` image.
3. Create/push the approved version tag only after main succeeds. The existing `GITHUB_TOKEN` publishes the version and `latest` for linux/amd64. Verify tag/package parity, image digest and MCP version inside the published image. This maintenance PR does not authorize that step.
4. Confirm package visibility Public and anonymous pull using an empty Docker config. No PAT, pairing token or runtime API key belongs in Actions. PR CI only builds/tests an ephemeral local image; it never logs into GHCR or pushes an image.

## Production upgrade and rollback advice

Production upgrade is a separate authorization after release. Keep the currently pinned 0.4.0 image/digest and working configuration. First test the new image with a separate synthetic account, especially Android/web synchronization, load meaning, custom renames and conflict behavior. The CI frontend store checks do not replace real device acceptance.

For an authorized upgrade, privately back up the current Compose configuration and data (including private drafts, feedback, backups and catalogue), note the current image digest, keep writes off, and pull the approved immutable image. Refresh only the optional text catalogue if needed, without touching credentials or other store files. Recreate only the Bridge service; leave openGym and Tunnel running. Check health/MCP initialization and read-only queries before allowing a small previewed write.

To roll back code, pin the previous known-good digest/tag and recreate only the Bridge service. Retain the private local store even if the older code cannot show a newer projection. Do not delete store/secrets or replace training data with an old snapshot. Code rollback does not undo already accepted training edits; use reviewed selective recovery above if required. No Watchtower or unattended production replacement is introduced.
