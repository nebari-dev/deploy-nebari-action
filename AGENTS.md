# AGENTS.md

Guidance for contributors and AI coding agents working in this repository.

This file follows the [AGENTS.md](https://agents.md) convention and is read by Claude Code, Codex, Cursor, Aider, Jules, GitHub Copilot, and other agent tooling, as well as by humans.

## Project Overview

**deploy-nebari-action** is a TypeScript GitHub Action that deploys a Nebari platform from a config file with the [`nic` CLI](https://github.com/nebari-dev/nebari-infrastructure-core), and destroys it automatically when the job ends, even on failure or cancellation.

A single `uses:` step:

- **Acquires `nic`**: a prebuilt binary (`nic-binary`), a release download verified by build-provenance attestation and checksum (`nic-version: latest` or `vX.Y.Z`), or a source build from any Git ref of NIC.
- **Deploys**: runs `nic deploy -f <config>`, using the consumer's config or the built-in [`default-config.yaml`](default-config.yaml) (a local kind cluster with an auto-created local gitops repository).
- **Exports `KUBECONFIG`** so every later step in the job runs against the deployed cluster.
- **Waits for convergence**: `nebari-root` Synced, every Argo CD Application Healthy, and that state stable across consecutive polls, failing fast when a container crashloops past its restart budget.
- **Exposes platform outputs** (domain, Keycloak issuer URL, masked admin credentials, gateway address) by passing through `nic outputs`.
- **Destroys** the deployment in a post step (`nic destroy`) when the job ends.

It is part of **Nebari Infrastructure Core (NIC)**. The sibling repository [`nebari-infrastructure-core`](https://github.com/nebari-dev/nebari-infrastructure-core) is the CLI this action drives; [`nebari-operator`](https://github.com/nebari-dev/nebari-operator) runs on the clusters it deploys. The action's main consumers are CI pipelines that need a throwaway Nebari platform to test against.

### Core Architecture Principles

1. **Teardown is the contract.** Whatever happens in the main step, the post step must be able to destroy what was created. State for teardown is saved _before_ `nic deploy` runs, so a deploy that fails halfway is still cleaned up.
1. **Validate every input before deploying.** A malformed input must cost seconds, not a completed cloud deploy followed by a teardown. Inputs are parsed strictly (no `parseInt(x) || default`), and `destroy` fails closed.
1. **NIC owns platform knowledge.** The action does not know which Secret, key, or Service backs an output; it shells out to `nic outputs` so the binary that deployed the platform is the one that reads it. Do not reintroduce direct Secret reads.
1. **Outputs never fail a successful deploy.** Output extraction degrades every platform output to empty with a warning instead of failing the step.
1. **Secrets never reach the log.** Tokens and credentials are registered with `core.setSecret` before anything that could print them, and raw `nic` stderr from a failed `nic outputs` run is never echoed.
1. **Synchronous by design.** Commands run through `spawnSync` and polling sleeps with `Atomics.wait`. There is no async code in `src/`; keep it that way unless there is a concrete reason.

## Common Development Commands

Requires Node.js 24 (pinned in [`.node-version`](.node-version); the action runs on `node24`).

| Command                | Description                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `npm install`          | Install dependencies.                                                                               |
| `npm run test`         | Run the Jest unit tests with coverage (`npm run ci-test` is the same, used by CI).                  |
| `npm run lint`         | ESLint over the repository.                                                                         |
| `npm run format:check` | Prettier check (CI gate). `npm run format:write` fixes it.                                          |
| `npm run docs`         | Regenerate the README inputs/outputs tables from `action.yml` (`action-docs`).                      |
| `npm run package`      | Rebuild `dist/` with Rollup.                                                                        |
| `npm run bundle`       | `docs` + `format:write` + `package`. **Run after any change to `src/` or `action.yml`.**            |
| `npm run all`          | `docs`, `format:write`, `lint`, `test`, `coverage` badge, and `package` in one go.                  |
| `npm run local-action` | Run `src/main.ts` locally via `@github/local-action`, with inputs from `.env` (see `.env.example`). |
| `script/release`       | Interactive helper that tags a release and moves the major tag (see [Releases](#releases)).         |

`npm run bundle` rewrites `README.md` and reformats the whole tree in addition to rebuilding `dist/`. Expect those diffs and commit them.

## High-Level Architecture

### Component Structure

```text
action.yml            Inputs, outputs, and the two entry points (runs.main / runs.post)
default-config.yaml   Built-in NIC config used when the `config` input is empty; read at runtime
src/
  index.ts            Main-step entry point -> dist/index.js (calls main.run)
  main.ts             Resolve config, acquire nic, validate inputs, save teardown state,
                      deploy, export KUBECONFIG, wait, extract outputs
  nic.ts              Command helpers (run, capture), nic acquisition (release download
                      with provenance + checksum verification, or source build), and
                      the Argo CD convergence wait with restart budgets and diagnostics
  outputs.ts          `nic outputs` passthrough: FIELDS table, masking, degrade-to-empty
  post-entry.ts       Post-step entry point -> dist/post.js (calls post.run)
  post.ts             Read saved state and run `nic destroy`
__tests__/            Jest unit tests, one file per src module
__fixtures__/         Typed jest.fn() mocks for @actions/core and the src modules
dist/                 Generated bundles (index.js, post.js); do not hand-edit
script/release        Release tagging helper
```

### Main and Post Steps

`action.yml` declares two entry points. They run in separate Node processes, so the only channel between them is `core.saveState` / `core.getState`:

| State key       | Saved by `main.ts`                                   | Used by `post.ts`                                    |
| --------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| `nicBinary`     | right after acquisition                              | binary to run `nic destroy` with                     |
| `config`        | right after acquisition                              | `-f` argument to `nic destroy`                       |
| `destroy`       | normalized `'true'`/`'false'` from `getBooleanInput` | skip teardown with a warning when `'false'`          |
| `force`         | normalized `'true'`/`'false'` from `getBooleanInput` | add `--force` to `nic destroy`                       |
| `deployStarted` | only after **all** inputs validate                   | skip teardown entirely when unset (nothing deployed) |

Ordering in `deploy()` matters. Teardown state is saved before `nic deploy`, so a partial deploy is destroyed. `deployStarted` is saved after the last input validation, so a run that failed on a bad input does not try to destroy anything. If you add a state key or an input that must be validated, place it accordingly and cover the ordering in `__tests__/main.test.ts`.

### Execution Flow

```text
main step (dist/index.js):
  resolveConfig                 config input, or default-config.yaml next to dist/
  acquireNic                    nic-binary | nic-version (latest / vX.Y.Z / git ref)
  nic version
  saveState(nicBinary, config, destroy, force)
  validate wait-timeout, restart-budgets, outputs-wait-timeout
  saveState(deployStarted)
  nic deploy -f <config>
  nic kubeconfig -o $RUNNER_TEMP/nic-kubeconfig-<step>  -> export KUBECONFIG, output kubeconfig
  waitForApplications           (if wait) poll Argo CD Applications until stable
  extractPlatformOutputs        nic outputs --format json --show-secrets --wait

post step (dist/post.js):
  deployStarted? destroy? -> nic destroy -f <config> --auto-approve [--force]
```

### nic Acquisition

`acquireNic` in `src/nic.ts`:

- `nic-binary` and `nic-version` are mutually exclusive; exactly one must be set.
- Release tags (`vX.Y.Z`, or `latest` resolved through the GitHub API) download the release tarball, verify it with `gh attestation verify` pinned to NIC's `release.yml` signer workflow, then check its entry in `checksums.txt`. Releases older than `MIN_ATTESTED_VERSION` (`v0.10.0`) are refused rather than downgraded to checksum-only verification.
- Any other string is treated as a Git ref and built from source with `go build` (requires Go on the runner).
- The `token` input is masked with `core.setSecret` before use.

Do not weaken verification (skipping the attestation, accepting a missing checksum) to work around a failure. Fix the cause or surface a clear error.

### Convergence Wait

`waitForApplications` in `src/nic.ts` polls `kubectl get applications.argoproj.io -n argocd` until `nebari-root` is Synced, every Application is Healthy, and that state (with the same Application set) holds for `REQUIRED_STABLE_POLLS` consecutive polls. Healthy-but-OutOfSync Applications only warn for now; the TODO on the function links the upstream issues that gate the stricter check.

It also enforces per-namespace container restart budgets so a crashloop fails the wait early instead of burning the timeout. Budgets are measured against a baseline taken on the first poll, keyed by pod UID. Built-in overrides live in `RESTART_BUDGET_OVERRIDES`; consumers override them with the `restart-budgets` input (`ns=count`, `*=count`). On timeout or breach, `dumpDiagnostics` prints Application statuses, pods, and Warning events before the step fails. Transient `kubectl` failures must never fail an otherwise converging wait.

### Platform Outputs

`extractPlatformOutputs` in `src/outputs.ts` runs `nic outputs` (requires nic `v0.14.0`+, `MIN_OUTPUTS_VERSION`) and maps its JSON keys to action outputs through the `FIELDS` table. `nic outputs` resolves all fields or none, so every failure path calls `degrade()`, which sets every output to empty and emits one warning. The warning text is built from slog `error` fields extracted from stderr (`slogErrors`), never raw stderr. Credentials are passed to `core.setSecret` before any success-path logging, and only "found"/"not found" is ever logged for them.

## Key Development Patterns

### Adding or Changing an Input

1. Add it to `action.yml` with a description and a default.
1. Read it in `src/main.ts`. Validate it strictly and **before** `deployStarted` is saved and `nic deploy` runs; throw a message that names the input and the bad value.
1. If the post step needs it, save it with `core.saveState` before `nic deploy`, normalized to a canonical string.
1. Add success and failure cases to `__tests__/main.test.ts`, including "fails before deploy" and "does not set `deployStarted`" assertions.
1. Run `npm run bundle` to refresh the README tables and `dist/`. Update the README usage sections if behavior changes.

### Adding a Platform Output

1. Confirm `nic outputs --format json` reports the field upstream (NIC owns the layout).
1. Add an entry to `FIELDS` in `src/outputs.ts` (mark `secret: true` for credentials) and the output to `action.yml`.
1. Extend `__tests__/outputs.test.ts`, and the `Check platform outputs` step in `.github/workflows/ci.yml`, which is the only end-to-end check that the real key name matches.
1. Run `npm run bundle`.

### Running Commands

Use `run()` (streams output to the log, throws on failure) or `capture()` (returns stdout, throws with stderr) from `src/nic.ts`. Call `spawnSync` directly only when you need to inspect a failure without throwing, as `waitForApplications` and `extractPlatformOutputs` do. Wrap long-running commands in `core.startGroup` / `core.endGroup` and close the group in `finally`, so a failure's output is not hidden inside a collapsed group.

## Conventions

- **Logging:** use `@actions/core` (`info`, `warning`, `startGroup`, `setFailed`), never `console`.
- **Errors:** each entry point's `run()` catches everything and calls `core.setFailed`. Inside, throw `Error`s with actionable messages that say what was wrong and how to fix it.
- **Comments explain why.** The codebase leans on comments that record the reason for a choice (often with the upstream issue or commit that motivated it). Keep that up and do not restate what the code does. Use JSDoc on exported functions.
- **Types:** `strict` TypeScript, ES modules with `.js` import specifiers (`NodeNext`).
- **Formatting:** Prettier (no semicolons, single quotes, no trailing commas, 80 columns). Markdown paragraphs are kept on a single line (`MD013` is disabled).

### Generated Files

- `dist/` is produced by `npm run package`. Never hand-edit it, and do not review its diffs; review `src/` instead. CI (`check-dist.yml`) rebuilds it and fails when the committed copy differs.
- The README sections between the `<!-- action-docs-inputs -->` and `<!-- action-docs-outputs -->` markers are generated from `action.yml` by `npm run docs`. Edit `action.yml`, not the tables. CI fails when the README is stale.
- `badges/coverage.svg` is produced by `npm run coverage`.
- `.licenses/` is maintained by the `licensed` workflow.

## Testing

### Unit Tests

Jest with `ts-jest` in ESM mode, one file per module in `__tests__/`. The pattern is:

1. Declare mocks with `jest.unstable_mockModule` using the typed fixtures in `__fixtures__/` (`core.ts`, `nic.ts`, `outputs.ts`), or a local `jest.fn` for `node:child_process`.
1. Import the module under test **dynamically** (`await import('../src/x.js')`) after the mocks are declared.
1. Configure inputs and state through the fixture mocks.

`__tests__/nic.test.ts` mocks `spawnSync` and stubs `Atomics.wait` so multi-poll waits run instantly, and uses real temp directories where creating a file is simpler than mocking `fs`. When you add a new export to a mocked module, add it to the matching fixture.

Cover both success and failure paths, especially anything that affects teardown or secret handling. **Never disable or skip a test to get CI green; fix the underlying cause.**

### End-to-End Test

The `GitHub Actions Test` job in `ci.yml` runs the action itself (`uses: ./`) with `nic-version: latest` and the default config on a real kind cluster. It asserts that every platform output is non-empty, that `domain` and `keycloak-issuer-url` have their pinned values, and that the three credentials are distinct. The post step then destroys the cluster. This is the only check that exercises real `nic`, so changes to command arguments or output parsing must keep it green.

### CI

| Workflow              | What it checks                                                                     |
| --------------------- | ---------------------------------------------------------------------------------- |
| `ci.yml`              | Prettier, README docs in sync, ESLint, unit tests, and the end-to-end action run.  |
| `check-dist.yml`      | `dist/` matches a fresh `npm run bundle`.                                          |
| `linter.yml`          | super-linter over the repository (markdownlint, yamllint, actionlint, checkov...). |
| `codeql-analysis.yml` | CodeQL on `src/`.                                                                  |
| `licensed.yml`        | Dependency licenses (manual dispatch).                                             |

## Releases

Consumers pin `nebari-dev/deploy-nebari-action@v0` (floating major tag), a full `vX.Y.Z` tag, or `@main`. Git tags are the source of truth for the version; the `version` field in `package.json` is not kept in step with them.

To release, publish a GitHub Release for a new `vX.Y.Z` tag on `main`. `publish.yml` then moves the floating major tag (`v0`) to it via `actions/publish-action`. `script/release` is an interactive alternative that creates and pushes the tags from a local checkout. Make sure `dist/` on the tagged commit is current, since that is the code consumers run.

Breaking changes to inputs, outputs, defaults, or teardown behavior need a new major version.

## Documentation

- **[README.md](README.md)**: user-facing usage, with generated input/output tables.
- **[action.yml](action.yml)**: the authoritative description of every input and output.
- **[SECURITY.md](SECURITY.md)**: private vulnerability reporting.
- **NIC docs**: [`nic outputs` reference](https://github.com/nebari-dev/nebari-infrastructure-core/blob/main/docs/reference/cli/nic_outputs.md) and the NIC [AGENTS.md](https://github.com/nebari-dev/nebari-infrastructure-core/blob/main/AGENTS.md) for anything about how `nic` itself behaves.

## Contribution Workflow

1. Branch from `main` with a conventional prefix (`feat/...`, `fix/...`, `chore/...`, `docs/...`, `test/...`).
1. Make the change and add tests.
1. Run `npm run bundle` if you touched `src/` or `action.yml`, and commit the regenerated `dist/` and `README.md`.
1. Use **Conventional Commits** for messages.
1. Open a PR with a summary, any dependency changes called out, and links to related issues. Keep PRs focused. If behavior or usage changes, the README must change in the same PR.

## Pre-Commit Checklist

1. **Format:** `npm run format:check`
1. **Lint:** `npm run lint`
1. **Unit tests:** `npm run test`
1. **Bundle:** `npm run bundle`, with `dist/` and `README.md` committed
1. **Input validation** happens before `deployStarted` and `nic deploy`
1. **Teardown state** that the post step needs is saved before `nic deploy`
1. **Secrets** are passed to `core.setSecret` before anything that could log them

## Keeping This File Current

This file is hand-authored. If you change the main/post state contract, the execution order, the acquisition or verification flow, a convention, or the release process, update the matching section here in the same PR.
