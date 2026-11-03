# Validation, dependencies, reuse and performance — 0.3.0

These tools run locally or on your runners. They need no hosted CI Planner service or model. They do not publish releases or change existing CI. JSON is the default; use `--format markdown` or `--summary` for a readable report.

## Validate skip suggestions against a full run

Keep shadow mode enabled so every check runs. Save the plan and collect the exact completed attempt with `audit --snapshot`. A trusted collector must record the actual tested merge and confirm that none of the compared jobs was gated. GitHub run metadata alone cannot prove either fact.

Create an observation file with these fields:

| Field     | Meaning                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------- |
| plan      | The full shadow plan JSON, including its exact base, head and tested merge.                        |
| snapshot  | The audit metadata snapshot for that repository.                                                   |
| workflow  | Full workflow path, such as .github/workflows/ci.yml.                                              |
| runId     | The observed run ID as an integer.                                                                 |
| testedSha | Actual full merge commit tested by this run.                                                       |
| fullRun   | true only after the trusted collector verifies ungated execution.                                  |
| jobNames  | Map from workflow#job_id to an array of every expected display name, including all matrix members. |

For example, jobNames may contain `{".github/workflows/ci.yml#test":["test (22)","test (24)"]}`. Do not infer matrix coverage from a shared prefix. Each observed name must be unique and mapped once.

    ci-planner validate --input observation.json --check --format markdown

`--check` exits nonzero on failed, missing, skipped, cancelled, unfinished, mismatched or ambiguous evidence. A failed job that the plan suggested skipping produces `failed-suggested-skip`. One passing run is an observation, not proof of complete inputs.

Save each JSON validation report in owner-controlled storage to build a history. A trusted CI coordinator can supply a report for the exact repository and shadow plan using `plan --workflow .github/workflows/ci.yml --validation-input validation.json` or the Action's validation-input. An unreadable, mismatched or unsafe report forces all jobs to run. Repository, policy hash, workflow and exact shadow-plan hash must match; a report for another source revision cannot clear the fallback. Enforcement requests are compared to their equivalent shadow plan, since enforce-mode hashes bind different decisions. It also changes the plan hash. Passing feedback does not enable enforcement or replace the existing base-policy and exact-merge gates. This is an explicit integration: CI Planner does not keep a shared database or fetch a report by itself. A report digest detects accidental changes; it is not a signature. Never let PR-controlled files replace the owner's feedback history.

## Discover JS/TS dependencies

    ci-planner discover --root /path/to/repo --ref HEAD --base BASE_SHA --format markdown

This reads committed Git objects, not dirty files. It finds npm/Yarn workspace patterns, pnpm workspace patterns, package dependencies and local links, literal imports and re-exports, CommonJS require calls, and TypeScript project references. Cross-package edges are transitive; cycles terminate. Root build configuration and lockfile changes mark all discovered packages affected. Package-level changes also mark dependent packages affected.

Each package includes suggestedInputs and dependencies. Every inputsComplete value remains false. Review these suggestions before changing an owner's input policy. Discovery never narrows a policy, enables a skip or runs repository code.

JSONC, unsupported workspace patterns, dynamic imports, TS aliases, unresolved modules and runtime file/network access remain warnings. The scan is an over-approximation, not a JavaScript parser or a proof that all inputs were found. Build config files appear as shared inputs; their code is never evaluated. Generated files and custom resolution need owner review.

Limits: 20,000 tracked paths, 2,000 readable text files, 500 packages, 256 KiB per text file and 16 MiB of source in total. Blob sizes are listed before reading. Larger lockfiles or generated source stay in the inventory as unreadable, with oversized-text-file warnings; they do not stop the scan. After the readable-file or source-byte budget is reached, remaining files stay unread with text-file-budget or source-byte-budget warnings. The report includes the total unreadableFiles count even when the warning list is capped. The 20,000-path inventory bound still stops discovery. Symlinks and submodules are not followed.

## Reuse a verified PR result on main

Reuse is a separate opt-in tool. The ordinary planner still runs every job on push events. A green run with the same head is insufficient: it does not prove what was checked out, which runtime was used, whether a gate skipped tests, or whether artifacts are needed.

The owner must commit `.ci-planner-reuse.json` on the default branch before the change being validated:

```json
{
  "schemaVersion": 1,
  "workflow": ".github/workflows/ci.yml",
  "hermetic": true,
  "noArtifacts": true,
  "environmentHash": "SHA256_OF_MEASURED_ENVIRONMENT",
  "maxAgeSeconds": 3600,
  "publicKeys": ["PEM_ED25519_PUBLIC_KEY"],
  "jobs": ["test (22)", "test (24)"]
}
```

The placeholders must be replaced with the actual 64-character digest and public key. There is no default reuse contract. Public keys may be committed; private keys must remain outside the checkout and outside PR execution.

The hermetic assertion is an owner decision: approve only checks whose results depend on the tracked tree and measured environment, with no event/ref-dependent behavior, unversioned network data, external state, secrets, or side effects. noArtifacts asserts that downstream work needs no files or outputs from the source run. Do not use this for builds that must produce artifacts, deployment, release, signing or device acceptance gates.

Use a separate trusted coordinator to observe an ungated successful PR run, its actual checkout, and a measured environment digest. Include resolved action and container digests, runner/toolchain identity, architecture and dependency installation inputs in that digest; hash canonical non-secret identities, never credentials. This release verifies the digest but does not measure an arbitrary runtime for you. If that identity is unavailable, run fresh.

The coordinator must not execute PR code, parse private keys with PR dependencies, or treat unsigned artifacts as tested-checkout facts. It should use a separately pinned installation of CI Planner and an independent protected job/key store. A workflow_run trigger alone does not make untrusted artifacts safe. Rotate a key by committing the trusted public-key set. A newly added key cannot authorize reuse for that same change; it becomes trusted for later merges.

    ci-planner attest --root /trusted/git-objects --repository OWNER/REPO --tested TESTED_SHA --run-id RUN_ID --environment ENVIRONMENT_HASH --signing-key-file /protected/ed25519.pem --full-run > receipt.json

Signing is explicit and forbidden in pull_request and pull_request_target contexts. The coordinator's --tested, --environment and --full-run values are trusted assertions. CI Planner verifies a successful unprivileged PR run and its complete latest attempt, requires every job and every reported step to succeed uniquely (skipped steps are refused), and binds that inventory, actual tested commit/tree, runtime digest and issuance time into an Ed25519 signature. It rereads the run to detect attempt drift. It does not infer ungated execution from a green conclusion.

On the main push, supply the independently measured current environment and the receipt:

    ci-planner reuse --root /path/to/repo --repository OWNER/REPO --base BEFORE_PUSH_SHA --target MAIN_SHA --environment CURRENT_ENVIRONMENT_HASH --input receipt.json --format markdown

The caller must provide --base as the trusted default-branch tip before the push, rather than infer it from PR files. Verification requires that base to equal targetSha^1 and reads the owner contract from it, before the merged change, and checks the signature against those prior public keys, owner opt-in, expected workflow and exact job names, age (at most 24 hours), identical environment digest and identical **whole Git tree**. Source, lockfiles, workflow and reuse policy must all match. It also checks the remote default-branch head, rereads the live latest PR attempt and all jobs, then checks the branch again. Fetch the target, its first parent, and the tested commit first. A missing parent or prior contract runs fresh. This single-change model supports a two-parent merge or a single squash commit. A multi-commit push whose first parent differs from the trusted pre-push tip runs fresh.

The JSON result has reusable=false and run=true on any uncertainty, including a missing receipt, changed run attempt, unavailable GitHub metadata or unknown environment. Evidence is a point-in-time observation; if it changes before consumption, run again. Receipts expire. No artifacts are restored and no GitHub check is marked successful.

For an explicit main-push integration, add --github-output only when GITHUB_EVENT_NAME, GITHUB_REPOSITORY and GITHUB_SHA describe that exact push. The CLI also requires the GitHub push payload in GITHUB_EVENT_PATH to confirm before, after and repository, and refuses reuse after forced or deleted pushes. Missing or mismatched push evidence runs fresh. Keep continue-on-error on the verification step and retain the fallback `steps.reuse.outputs.ready != 'true' || steps.reuse.outputs.run != 'false'` on validation. The verifier also requires target to be the live default-branch head. Never gate release/deployment jobs with this result. Existing required-check and acceptance rules still apply.

## Review CI performance

    ci-planner audit --repository OWNER/REPO --snapshot > snapshot.json
    ci-planner advise --input snapshot.json --format markdown
    ci-planner advise --repository OWNER/REPO --workflow ci.yml --limit 20

Advice uses bounded job and step timing, not logs. It highlights explicit shard labels with uneven durations, repeated install steps, long cache transfers, expensive installs with unknown cache configuration, and the last job's finishing tail. It does not claim that a job is on the dependency graph's critical path, that an install can be shared safely, or that absent visible cache steps prove a miss.

Default GitHub metadata does not report cache hits. For measured hit-rate advice, a trusted collector may add cacheObservations to its snapshot: each record has jobId, stepNumber and boolean hit, and must identify an observed step. Duplicate or unbound observations are rejected. At least three observations with a hit rate below 50% produce a review prompt. Without instrumentation, hitRate stays null.

Timing thresholds are review heuristics: an explicit shard at least two minutes long and 1.5 times the shortest peer; install steps at least 30 seconds in two jobs; installs or cache transfers at least one minute; and a finishing tail at least one minute. Different matrix workloads and partial runs can skew these observations. Savings and billing remain null. Review changes manually and preserve runner placement, test coverage and all acceptance gates.

## Changes in 0.4.0

Attestation requires testedSha to equal the successful GitHub run head exactly. A two-parent commit with that head as its second parent does not prove the merge tree was executed and cannot be signed. This may force ordinary PR synthetic-merge integrations to run fresh; independent coordinator-proved merge signing is not implemented.

Validation feedback intentionally binds head and merge through the exact shadow-plan hash. A new push requires new full-run feedback. Historical passing observations never clear a later revision's fallback.

Performance reports contain one jobSummaries row per workflow/display-name pair: sample count, timed samples, incomplete samples, median duration, nearest-rank p90, median observed shard ratio, summed install-step time and median worker-seconds from complete successful PR samples. Failed/cancelled durations remain in the descriptive median/p90; estimates use only complete successful PR runs. Matrix members retain separate names. Repeated findings retain their supporting run IDs and observation count. Install time is observed setup, not proven avoidable waste.

Supply explicit cost rates to audit with `--rates rates.json` in live or offline mode:

```json
{"currency":"USD","perMinute":{"ubuntu-latest":0.008,"self-hosted":0}}
```

A job needs one unambiguous matching rate from its observed runner labels. Unknown/conflicting labels remain unrated. estimatedCost shows the rated and unrated seconds and whether the estimate is partial. Costs use unrounded observed execution time at owner rates; billing, queue time, included allowances and proven savings remain unknown. Rates are not fetched or invented. Older snapshots without labels cannot be priced.
