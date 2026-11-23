# openGym MCP Bridge

[![Test and publish Docker image](https://github.com/Nirvana-Z777/opengym-mcp-bridge/actions/workflows/publish-image.yml/badge.svg)](https://github.com/Nirvana-Z777/opengym-mcp-bridge/actions/workflows/publish-image.yml)

A community-maintained, self-hosted MCP bridge for [openGym](https://github.com/DuarteSantos8/openGym). This is **not an official openGym project**.

The current stable release is **v0.5.0**. The `fix/v0.5.1-catalogue-proposal-invalidation` branch develops catalogue-refresh safety fixes from that release. See the [v0.5.0 guide](docs/v0.5.0.md), [v0.5.1 change notes](docs/v0.5.1.md), [operations guide](docs/operations.md), and [v0.4.1 baseline](docs/v0.4.1.md). A development branch does not make its image available as a release.

## Published image

```text
ghcr.io/nirvana-z777/opengym-mcp-bridge:0.5.0
```

The image targets `linux/amd64`. Pin a released version or verified digest for deployments. `latest` tracks the most recent stable release. The example Compose file stays on the currently published `0.5.0` image while v0.5.1 is under review. The optional tunnel-client is an independent image and is not changed by this Bridge release.

GitHub Actions tests and builds pull requests without package-write permission. Merging to `main` publishes the development `main` image. A verified version tag publishes the matching version and `latest` through GitHub's `GITHUB_TOKEN`. See the release steps in [operations](docs/operations.md).

## Capabilities

The Bridge provides 52 MCP tools, with 32 available when upstream writes are disabled. They cover:

- Connection status, summaries, plans, recent sessions and official exercise search.
- Previewed plan changes and historical workout logging, with explicit confirmation, revision checks, local backup, one write and readback.
- Custom exercises, paginated workout history, workout details, exercise history and guarded edits to saved sessions.
- Today-plan resolution, resumable workout drafts, session timing, measured sets, completion reports, progress and weekly muscle summaries.
- Native openGym weigh-ins and circumference reads, plus explicitly selected, previewed synchronization to openGym.
- Bridge-private pre-session questionnaires, per-exercise feedback and body feedback. These records remain in the Bridge's account-scoped local store and are separate from native openGym body measurements.
- Evidence-based next-session suggestions and five trend views for volume, muscle distribution, weight, exercise progress and discomfort. A suggestion does not change a routine. Selecting one creates a separate plan preview that still requires confirmation.
- Official exercise catalogue status, change preview and confirmed refresh. A refresh validates pinned upstream files, backs up the old local catalogue, and replaces it atomically. In v0.5.1, a successful catalogue change also invalidates pending upstream-write previews created against the prior catalogue.

Tool names are `search`, `fetch`, `get_status`, `get_summary`, `get_plan`, `get_recent_workouts`, `search_exercises`, `preview_plan_change`, `preview_workout_log`, `log_workout`, `apply_plan_change`, `get_catalogue_status`, `preview_catalogue_refresh`, `apply_catalogue_refresh`, `list_custom_exercises`, `preview_custom_exercise_change`, `apply_custom_exercise_change`, `list_workouts`, `get_workout`, `get_exercise_history`, `preview_workout_edit`, `apply_workout_edit`, `get_native_body_data`, `preview_body_sync`, `apply_body_sync`, `record_session_feedback`, `list_session_feedback`, `get_training_suggestion`, `preview_training_suggestion`, `get_training_trend`, `get_today_plan`, `preview_planned_session`, `start_planned_workout`, `draft_session_clock`, `start_workout_draft`, `list_workout_drafts`, `get_workout_draft`, `draft_add_exercise`, `draft_remove_exercise`, `draft_add_set`, `draft_update_set`, `draft_remove_set`, `draft_set_note`, `draft_set_routine`, `preview_finish_workout_draft`, `commit_finished_workout_draft`, `abandon_workout_draft`, `recover_workout_draft`, `get_workout_progress`, `get_weekly_training_summary`, `record_body_feedback`, and `list_body_feedback`.

Every upstream write requires the exact preview, explicit confirmation `我确认写入`, a fresh revision/write-ID/content check, a private backup and a readback. If a response is uncertain, investigate read-only and do not retry the same proposal. Catalogue refreshes and upstream writes use one shared in-process guard. Run one Bridge writer against a given local store so separate processes cannot bypass that coordination.

## Quick deployment reference

1. Copy `.env.example` to `.env` and set `OPENGYM_BASE_URL` to the address reachable from the Bridge container.
2. Copy `docker-compose.example.yaml` to the private `docker-compose.yaml` used for deployment.
3. Create `secrets/` and `store/` locally. Pair through the supported flow, and keep pairing credentials private.
4. If using OpenAI Secure MCP Tunnel, copy `tunnel-client.example.yaml` to the private `tunnel-client.yaml`, then supply its credentials through the private `secrets/` files.
5. Keep `OPENGYM_ALLOW_WRITES=0` until writes are needed. Every upstream write still requires a short-lived preview and explicit confirmation.
6. Start with Docker Compose. The Bridge service uses the published GHCR image and does not build from the local source tree.

The example files are templates. Never publish a customized `.env`, `docker-compose.yaml`, `tunnel-client.yaml`, `secrets/`, `store/`, private backups, or training exports. Keep the MCP port on the private Docker network.

## Catalogue refresh

Use the MCP tools in order: call `get_catalogue_status`, call `preview_catalogue_refresh`, inspect the candidate version and reported changes, then call `apply_catalogue_refresh` with that preview ID only after explicit approval. A successful refresh backs up and atomically replaces the Bridge's local official catalogue. In v0.5.1, previews created before a successful catalogue change expire. A failed or unchanged refresh does not replace the catalogue. The maintenance CLI is a recovery fallback described in [operations](docs/operations.md).

## Local development

Requires Node.js 22 or newer. The Bridge has no npm runtime dependencies.

```bash
npm ci --ignore-scripts
npm test
npm start
```

Tests use synthetic accounts, identifiers, dates, measurements and set data. The compatibility jobs use isolated openGym versions and disposable test accounts. They do not access production credentials, NAS configuration or private training history. Pull requests also check Docker context exclusions, build `linux/amd64`, and smoke-test MCP initialization in a network-isolated container.

## Security and licensing

Never commit or bake `.env`, `secrets/`, `store/`, pairing tokens, MCP access tokens, runtime keys, personal tunnel settings, private IP addresses or workout exports into source or images. Docker build context excludes tests and local configuration. GitHub Actions uses the automatically supplied `GITHUB_TOKEN`; image publishing does not need a PAT or runtime credential.

This project is MIT licensed. See [LICENSE](LICENSE).
