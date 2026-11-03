# Historical replay, affected tests and wider checks

These tools analyze immutable committed files. They never execute repository code, load test configuration, infer `inputsComplete`, or enable planner enforcement. The separate consumer example deliberately executes the owner's test runner.

## Replay merged PRs

```sh
ci-planner history --repository Gamenalyze/ci-planner --root . \
  --limit 3 --contract examples/history-contract.json --fetch
```

The explicit owner-reviewed contract maps every workflow job ID to all expected display names, including matrix names, and lists the actual validation steps that must have run. It is not read from a PR artifact. The example contract describes this repository's earlier two-lane CI; adapt it for another repository or later workflow revisions. A changed matrix or step inventory becomes unknown rather than guessed.

Collection reads at most 500 closed PRs, orders merged entries by merge time, then selects up to 20. `selection.complete` says whether this is an exhausted inventory rather than a bounded subset. Matching PR-head runs are inspected attempt by attempt (at most five attempts per run). Job pagination, run identity, required steps, checkout success, static ungated workflow definitions and explicit matrix-name coverage are checked. Logs are read only into memory to extract the pinned checkout's final full commit ID within its step interval. Raw logs are not included in reports. At most 100 attempt records, 250 requests, 40 job logs, 32 MiB of responses, and five job pages per attempt are allowed. Each Git/API/log operation has its own timeout; a missing or retired commit, missing log, partial run or exhausted budget remains unknown.

`--fetch` explicitly permits fetching validated object IDs from the named GitHub repository. Without it, objects must already exist locally. No repository-provided scripts or hooks run during analysis. The tested commit must have the exact PR head as its second parent; the first parent determines the historical trusted base policy. The current policy is not retroactively asserted over old history.

Candidate successful-job worker time, failed suggested skips, and unknown attempts are separate fields. A confirmed failing required step can remain an observed failed suggested skip even when later required steps were skipped and the attempt is incomplete; that incomplete attempt contributes no candidate savings. A checked-out merge and successful named steps establish bounded execution observations, not test quality, all possible runtime inputs or absence of subsequent arbitrary code effects. Zero observed failed skips in a sample cannot certify enforcement safety. Worker time is not workflow elapsed time, billed cost or realized savings.

## Consume affected tests

```sh
ci-planner affected --root . --base FULL_BASE_SHA --runner vitest > selection.json
```

The JSON includes `matrix.include`, `runAll`, selected `tests`, and reasons. Matrix rows are valid consumer selections; full-suite rows omit the unused test list. Narrowed arguments are capped at 1,000 paths and 32 KiB. See the [Actions consumer with an independent run-all fallback](../examples/affected-tests.yml). Both `jest` and `vitest` runner labels are supported. Static reverse import/re-export edges narrow only default single-package JavaScript ESM suites. The parser does not execute imports. TypeScript/JSX/CommonJS, aliases, custom transforms/configuration, setup files, dynamic imports, reflection, filesystem/network/environment inputs, external module semantics, snapshot files and deleted/unknown inputs select the full suite. This deliberately trades precision for conservative behavior.

Copy [the consumer runner](../examples/run-affected-tests.mjs) into an owner-reviewed workflow. Supply the complete selection JSON through `CI_PLANNER_SELECTION`, and `TEST_RUNNER=jest` or `vitest`. A missing, invalid, or failed selector runs all tests. Arguments are passed as an array; file names are not interpolated into shell code. A valid empty selection is the only case that does not invoke the runner. Do not gate the consumer on selector success without an independent run-all fallback.

The [single-package example](../examples/affected-tests-consumer/package.json) can be exercised with `npm run consumer:smoke`. It actually runs Vitest: changing `src/add.js` selects one of two tests; a package-manifest change and malformed selector each run both. The selector remains advisory and never sets a planner job's input contract complete. Jest has graph/argument coverage; an end-to-end Jest consumer is not claimed by that Vitest demonstration.

## Per-job setup and language evidence

`init` follows literal package scripts and Node entry imports and proposes per-job scopes. It records the invocation/import basis and uncertainty. Opaque wrappers, unresolved arguments and actions retain broad inventory scopes. All proposed job contracts stay `inputsComplete: false` in shadow mode.

`audit-repo` also recognizes Python roots, Go modules and repositories containing only Dockerfiles. Python examples include `python -m pytest`, `ruff check` and `python -m pip_audit`; Go examples include `go test ./...`, `go vet ./...`, `go build ./...` and `govulncheck ./...`. Partial invocations and masked failures remain conditional. Unknown wrappers remain unverified. Container build/lint evidence binds the explicit Dockerfile; one generic build cannot cover every Dockerfile. `covered` means a recognized blocking invocation, never passing CI or complete language coverage.

## Parser inventory and early gate

The Action and npm package ship their YAML and JavaScript parsers in `vendor/`, with upstream ISC/MIT licenses. They require no runtime npm installation. `npm ci` is used only for development/release regeneration and verification. `npm run vendor:generate` deliberately updates shipped files from the lockfile-verified installed versions. `npm run sbom:check` reproduces every shipped parser byte and deterministic CycloneDX inventory from that graph; added/missing/changed vendor files or a stale inventory fail the check. This is this repository's drift contract, not a generic vulnerability or SBOM compliance certification.

The main CI `metadata` job checks inventory and source syntax before the Node 22/24 matrix. The release verifier requires this gate and both lanes to succeed at the same canonical main commit. The separate `SBOM fail-fast proof` workflow can inject deliberate drift; the expected result is a failed metadata gate with skipped downstream work. It runs source tooling only, without native app builds.

Git object readers support SHA-1 and SHA-256 repositories. GitHub Action pin validation intentionally remains 40 hexadecimal characters. Shared option parsing rejects duplicate flags and missing values; shared workflow validation rejects nested paths and whitespace/control characters.
