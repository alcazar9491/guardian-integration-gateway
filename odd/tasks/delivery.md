# Feature: delivery

## Objective

Make Guardian Integration Gateway ready for assessment delivery: production-oriented Docker image and Compose stack, a complete README, repository hygiene verified, suggested commit messages, and a submission checklist, all verified by real runs.

## Scope

- In: `Dockerfile` (multi-stage, non-root, health check, graceful shutdown), `.dockerignore`, `docker-compose.yml` (persistent audit volume, environment configuration, hardening), `scripts/create-dev-env.mjs` (development-only key generation) with a test, `README.md`, `.gitignore` review, secret and PII scan of every file git would track, suggested commit messages, submission checklist, full verification including a real Compose run.
- Out: fixing the four warning-level review findings (not authorized; documented as known issues), pushing, committing, recording a video.

## Constraints

- No secrets in the image or the repository: keys reach the container only at runtime through the environment.
- Do not create or edit `.env*` files in the project (permission rule). The project template `.env.example` is created by the user from the staged scratchpad copy; the dev-env script is tested against a temporary directory only.
- Never claim a push, commit, or video recording that did not happen.
- Commit messages: Conventional Commits, no AI attribution (user's global rule).

## Workflow settings

- TDD: strict, ON for the dev-env script (behavior). Docker, Compose, README: verified by real runs, not unit tests.
- Route: delegated direct via one writer (writer trigger: 2+ non-trivial files).
- Git: local repository initialized by the parent (`git init -b main`), no commits, no remote.
- RDD assessment: not run (no commits).
- Engram mirror `odd/delivery/tasks`: PENDING. Engram MCP failed to connect this session.

## Tasks

- [x] T1 `scripts/create-dev-env.mjs` (TDD): writes a development `.env` with every variable and two fresh, distinct 32-byte keys; refuses to overwrite; mode `0600`; `npm run setup:dev-env`
- [x] T2 `Dockerfile` + `.dockerignore`: multi-stage build, production dependencies only, non-root `node` user, `/app/data` owned by `node` with mode `0700`, `HEALTHCHECK` via Node `fetch`, exec-form `CMD`, no secrets copied
- [x] T3 `docker-compose.yml`: named volume for `/app/data`, required keys via `${VAR:?}`, overridable port, provider, and breaker settings, `init`, `read_only`, `tmpfs /tmp`, `no-new-privileges`, `cap_drop: ALL`, `stop_grace_period` above the app's 10 s force-exit
- [x] T4 Real Docker verification: build, image inspection (user, no `.env`/keys/test files), Compose up, health, success with PII, audit records in the volume, `first:3` breaker sequence with measured latencies, graceful stop
- [x] T5 `README.md`: prerequisites, setup, configuration table, local/test/Compose commands, API examples, architecture diagram and flow, design patterns, security decisions, circuit breaker states and reproduction, demo-video guide, known limitations and known issues
- [x] T6 Repository hygiene: `.gitignore` review, `git status`, secret scan and PII scan of all files git would track, staged `env.example` refreshed
- [x] T7 Final verification: `npm run check`, `npm run build`, suggested commit messages, submission checklist

## Acceptance criteria

- `docker compose up --build` serves `/health` 200 as a non-root user with the audit file persisted in a named volume across restarts.
- With `AI_PROVIDER_FAILURES=first:3`, requests 1–3 return `PROVIDER_ERROR` after ~2 s and request 4 returns `CIRCUIT_OPEN` in milliseconds through Compose.
- The image contains no `.env`, keys, tests, or source maps of secrets; `docker history` shows no key material.
- No file git would track contains key material or real personal data.
- `npm run check` and `npm run build` pass.

## Progress and evidence

_Updated after each task._

- Baseline (before T1): `npm run check` exit 0, 30 files, 559 passed + 1 skipped.
- T1 (route: inline single writer): RED `test/scripts/create-dev-env.test.ts` 8 failed + 1 skipped (`Cannot find module scripts/create-dev-env.mjs`); GREEN 8 passed + 1 skipped (0600 mode test is POSIX-only, skipped on Windows). `eslint.config.js`: the non-type-checked override now covers `**/*.{js,mjs}` (the project service rejected the `.mjs` file). `npm run setup:dev-env -- <scratch path>` exit 0, second run exit 1 "Refusing to write ... already exists"; no project `.env` created; `tsc --noEmit` 0. Linux mode check in a throwaway `node:24.19-alpine` container: `600`.
- T2 (inline): base pinned to `node:24.19-alpine` (tag exists, `node --version` v24.19.0, digest `sha256:d32cdf61…ad43`). `.dockerignore` is an allow-list (`package*.json`, `tsconfig*.json`, `src/`) plus explicit denies; build context 236.53 kB.
- T3 (inline): `docker compose config --quiet` exit 0 with a scratch env file; without keys it exits 1 with the `:?` message.
- T4 (inline, project `guardian-verify`, `HOST_PORT=3999`, scratch env file from the T1 script, deleted afterwards): build exit 0 in 13 s; image 256 MB unpacked / 60.8 MB content (base 58.2 MB); `Config.User=node`; `docker history --no-trunc` contains neither key value nor key name; in-image: `uid=1000(node)`, `/app` root-owned, `/app/data` `drwx------ node:node`, no `.env*`, 0 test files, 0 `.ts` sources, no devDependencies, `/app/dist` not writable by `node`. Healthy after 2.2 s; `GET /health` 200 with all six security headers, no HSTS. PII POST 200 `COMPLETED` in 2069 ms, three labels, no original value in the response; audit file `0600 node:node` holds rev 1 `PENDING` + rev 2 `COMPLETED`, AES-256-GCM (12-byte IV, 16-byte tag, 84-byte ciphertext), no original value or raw userId; ciphertext decrypts with AAD `[auditId,userRef]` and `userRef` matches the HMAC. After `restart`: same 2 lines. After `down` + `up` with `AI_PROVIDER_FAILURES=first:3`: 2073 / 2026 / 2021 ms `PROVIDER_ERROR`, then 22 ms `CIRCUIT_OPEN`; log `{"circuit":{"from":"CLOSED","to":"OPEN"}}` at warn; after the 30 s cooldown one probe 2051 ms `COMPLETED`, logs `OPEN→HALF_OPEN`, `HALF_OPEN→CLOSED`. Audit: 12 lines, outcomes `PROVIDER_FAILURE`×3, `CIRCUIT_OPEN_FALLBACK`, `COMPLETED`×2. `stop` 843 ms, exit code 0, log `Shutting down` (`SIGTERM`). `down -v`: no containers or volumes left.
- T5 (inline): `README.md` written. Response and error examples are real outputs (field order as served); error shapes captured from the built app (400 blank/unknown field, 415, 400 malformed, 413, 404). README breaker snippets executed against a local `node dist/main.js` with `first:3`: bash/curl loop 2.045 / 2.018 / 2.024 s `PROVIDER_ERROR`, 0.008 s `CIRCUIT_OPEN`; PowerShell loop 2122 / 2022 / 2027 ms, 7 ms. Mermaid not rendered locally (no CLI).
- T6 (inline): `.gitignore` adds `.codegraph/`, `.vscode/`, `.idea/`, `*.swp`, `*~`, `*.tmp` (existing entries kept; `git check-ignore` confirms `.env`, `.env.local`, `data/`, `dist/`, `.atl/`, `.codegraph/`, `*.log` ignored and `.env.example` re-included). `git add --dry-run -A`: 124 files, nothing staged, no `.env`, `data/`, `dist/`, logs, `.atl`, or scratch files. Secret scan: 0 standalone 32-byte base64 strings; 292 raw base64 hits all inside `package-lock.json` `sha512` integrity lines; 2 hex-64 hits are the review's snapshot content hashes; 0 private keys, AWS, GitHub, or Slack tokens, and 0 password assignments. PII scan: only synthetic fixtures (single-letter or placeholder emails, Luhn-invalid numbers, test PAN 5500000000000004, advertising SSNs 123-45-6789 / 987-65-4321). Sanitizer check on the built code: `müller.hans@example.com` → `mü<REDACTED: EMAIL>` (the review's `müller<…>` example is inaccurate; README uses the measured output and a reserved domain). Staged `env.example`: 13 variables, keys empty, `loadConfig` rejects it without keys and accepts it with keys.
- T7 (inline): `npm run check` exit 0: 31 files, 567 passed + 2 skipped (both POSIX-only file-mode tests, skipped on Windows). `npm run build` exit 0 (64 `.js` in `dist/`). Final `git add --dry-run -A`: 124 files, 0 staged. Suggested 12-commit series covers all 124 files exactly once (checked by script); the RES-001 fix and the `security-headers` registration in `src/app.ts` ride in the audit and API commits because the files are untracked in their final state. No commit, push, or remote was made.

## Next step

User actions: create `.env.example` from the staged template, review and make the suggested commits, push, record the demo video (README "Demo-video guide"). Engram mirror `odd/delivery/tasks` still PENDING.
