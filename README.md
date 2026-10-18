# openGym MCP Bridge

[![Test and publish Docker image](https://github.com/Nirvana-Z777/opengym-mcp-bridge/actions/workflows/publish-image.yml/badge.svg)](https://github.com/Nirvana-Z777/opengym-mcp-bridge/actions/workflows/publish-image.yml)

A community-maintained, self-hosted MCP bridge for [openGym](https://github.com/DuarteSantos8/openGym). This is **not an official openGym project**.

- Reads the openGym account through its supported web/API interface and a dedicated paired token.
- Offers MCP tools for status, plan/history reads, official exercise-name search, guarded plan changes, and guarded historical workout logging.
- Supports confirmed, preview-first writes when `OPENGYM_ALLOW_WRITES=1`.
- v0.3.2 adds custom exercises, precise history queries, saved-workout edits, notes, phases, unilateral sets and mandatory local pre-write backups.
- Ships as a Docker image through GitHub Actions and GitHub Container Registry (GHCR).

This project is experimental. Back up your openGym data and inspect every write preview before confirming it.

The current release is **v0.3.2**. See [CHANGELOG](CHANGELOG.md), [tool inputs/outputs and examples](docs/tools.md), [openGym v1.4.1 compatibility and limits](docs/compatibility.md), [backup, recovery, upgrade and rollback procedures](docs/operations.md), and the [development security review](docs/security-review.md).

## Docker image

```text
ghcr.io/nirvana-z777/opengym-mcp-bridge:0.3.2
```

The image is built from this repository by `.github/workflows/publish-image.yml`. Pushing to `main` publishes the `main` tag. Pushing a version tag such as `v0.3.2` publishes `0.3.2` and `latest`. GitHub Actions runs `npm test` before publishing.

Images target `linux/amd64`. Pin `0.3.2` for a release deployment; `main` tracks development and `latest` tracks the most recent stable release. The Dockerfile contains runtime source, package metadata and the MIT license; test fixtures and local configuration are excluded from its build context.

## Security first

Never commit or bake any of the following into the repository or image:

- `secrets/`, `opengym-token.json`, `mcp-access-token`, `openai-runtime-key`
- `.env`, personal tunnel IDs/configuration, personal IP addresses or private workout exports
- `store/` or other user data

The repository ignores local secret/data paths. The Docker build context also excludes them. Keep the Bridge behind the Docker network and do not publish its MCP port directly to the Internet. The example Compose file does not map a host port.

## Quick deployment reference

1. Copy `.env.example` to `.env` and set `OPENGYM_BASE_URL` to the openGym address reachable from the Bridge container.
2. Copy `docker-compose.example.yaml` to your local `docker-compose.yaml`.
3. Create `secrets/` and `store/` locally. Pair the Bridge with openGym using its supported pairing flow; never paste pairing codes or tokens into public issues.
4. If using OpenAI Secure MCP Tunnel, copy `tunnel-client.example.yaml` to the local `tunnel-client.yaml`, replace the tunnel ID, and place the restricted runtime key and Bridge token in the expected files under `secrets/`.
5. Keep `OPENGYM_ALLOW_WRITES=0` until you are ready to use the write tools. When enabled, every write still requires a short-lived preview and explicit confirmation.
6. Deploy with Docker Compose. The Bridge uses the GHCR image, not `build: .`.

The example files are templates, not a ready-to-run configuration. Do not publish your locally customized `.env`, `docker-compose.yaml`, `tunnel-client.yaml`, or `secrets/`.

## MCP tools

Read-only tools include `get_status`, `get_summary`, `get_plan`, `get_recent_workouts`, and `search_exercises`. Writes are preview-first: `preview_plan_change` / `apply_plan_change` and `preview_workout_log` / `log_workout`. The apply/log tools are hidden when `OPENGYM_ALLOW_WRITES` is not `1`.

New tools: `list_custom_exercises`, `preview_custom_exercise_change` / `apply_custom_exercise_change`, `list_workouts`, `get_workout`, `get_exercise_history`, and `preview_workout_edit` / `apply_workout_edit`. All four formal writers require exact human confirmation `我确认写入`, a fresh version check and a successful local backup. The existing Compose store mount places backups at `/store/backups/`, retaining 20 by default. No automatic restore writer exists. Notes and descriptions are untrusted data.

Historical workout logging accepts real recorded dates and actual per-set data. For each set, provide exactly one of `reps` or `seconds`; do not invent unknown dates, weights, repetitions, or durations.

Unilateral reps instead require actual `sides.L` and `sides.R` measurements; timed sides use separate flat rows. Optional `phase`, effort and `weight_basis` preserve the native model without converting historical weights. Refresh the optional text catalogue with `node src/catalogue.mjs` for full metadata checks before custom creation/renaming or derived-record edits. Date/time migration, legacy identity migration and unsupported complex structures are explicitly refused; read the compatibility limits before use.

## Local development

Requires Node.js 22 or newer. The bridge has no npm runtime dependencies.

```bash
npm ci --ignore-scripts
npm test
npm start
```

All test identities, pairing codes, dates, body weights and per-set values are deliberately synthetic. Tests use mocked clients or temporary local files and never read personal secrets or contact a real openGym account. CI rejects a test run that executes zero tests. MCP initialization reports the version from `package.json`.

Pull requests also audit Docker context exclusion with synthetic canaries, build linux/amd64 and smoke-test MCP initialization with networking disabled. They do not receive package-write permission or publish images. Production upgrades remain a separate owner-approved operation.

## Release process

1. Update the version in `package.json`, regenerate `package-lock.json` with `npm install --package-lock-only --ignore-scripts`, and update the pinned image in this README and `docker-compose.example.yaml`.
2. Run `npm test` locally.
3. Commit and push to `main` to publish a `main` image for testing.
4. Create and push a tag such as `v0.3.2` to publish `0.3.2` and `latest`. CI verifies that the tag matches `package.json`; a failed test prevents publication.
5. After the first package publication, set the GHCR package visibility to **Public** in the package settings if GitHub created it as private by default.

The workflow authenticates with the automatically provided `GITHUB_TOKEN`. Its test job has `contents: read`; only the publishing job also receives `packages: write`. No PAT, runtime API key, pairing token or tunnel credential is required for image publication. Actions are pinned to reviewed commit SHAs; update those pins when adopting an upstream release.

After making the package public, verify a pull without stored registry credentials on a machine with Docker:

```bash
anonymous_config=$(mktemp -d)
docker --config "$anonymous_config" pull --platform linux/amd64 ghcr.io/nirvana-z777/opengym-mcp-bridge:0.3.2
docker --config "$anonymous_config" pull --platform linux/amd64 ghcr.io/nirvana-z777/opengym-mcp-bridge:latest
rmdir "$anonymous_config"
```

## License

MIT. See [LICENSE](LICENSE).
