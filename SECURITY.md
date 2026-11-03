# Security — 0.3.1

CI Planner analyzes untrusted repository metadata. It must not turn that metadata into privileged execution or successful evidence.

## Submodule skip bypass fixed in 0.3.1

Version 0.3.0 and earlier can miss a changed submodule gitlink when Git ignore settings hide it from the planner diff. This can wrongly skip an enforce-mode job even when its declared inputs include that submodule. Keep enforce disabled until using a reviewed v0.3.1 commit or release. Shadow mode still runs every check.

The fix uses an explicit --ignore-submodules=none override. Regression fixtures cover committed .gitmodules, local .git/config and dirty worktree .gitmodules settings. No published tag is moved by this change.

## Report a vulnerability

Use this repository's [private vulnerability reporting](https://github.com/Gamenalyze/ci-planner/security/advisories/new) for a skip bypass, trust-boundary issue, credential exposure or dependency vulnerability. Do not post secrets or private repository snapshots in public issues. No response-time guarantee or paid bounty is offered.

Use the latest published version. Fixes ship through reviewed commits and versioned releases.

## Boundaries

- Planning reads committed Git objects and base-owned policy.
- The CLI never executes the analyzed repository's scripts.
- The Action installs only its own locked parser, with lifecycle scripts disabled.
- Enforcement requires base opt-in, caller opt-in and exact base/head merge parents.
- Hidden or mutable execution inputs retain jobs; unsupported graphs fail planning.
- Missing outputs must make the caller run existing CI.
- A digest is not a signed plan or a cross-run execution attestation.
- Audit history cannot prove a safe skip or estimate billing.

The pure buildPlan API accepts normalized data for tests and trusted adapters. Do not expose its verifiedMerge input as a user-controlled authorization field.

## Data and permissions

There is no hosted backend or telemetry. Git data stays on your machine or runner. Live auditing uses installed gh authentication to GET run/job metadata. It does not request logs, artifacts, source contents or secret values. It retains bounded run/job and step name/status/timestamp metadata, never logs or step outputs.

Snapshots and plan job names can still reveal private project structure. Treat them as private within your organization. Use read-only contents/Actions permissions. Never pass a write token or extra secrets to a job that checks out untrusted PR code.

Input contracts are owner assertions. Undeclared shared files, external state or an incorrect ignored pattern can make a scope wrong. Start in shadow mode, retain sensitive checks and run periodic full validation.

CI Planner does not sign releases, approve deployment, alter coverage floors or replace privacy/release acceptance gates.

Version 0.1.0 has a reported downstream-invalidation skip defect. Upgrade to 0.2.1 or later before using enforce mode. The default remains shadow.

Readable reports are escaped and bounded, but names and paths can still reveal private structure. Keep summaries within the repository's access controls. Optional completeness reports and summary append failures cannot grant extra skips.

Guided init writes only missing setup files on explicit --write, in a clean local checkout. It never infers complete input knowledge or modifies existing CI. The generated advisory job uses read-only permissions and cannot enable skips.

The separate fix --open-pr operation is an explicit owner-authorized remote write. It is local-only, requires local HEAD to equal the remote default branch, creates only a new generated workflow, never updates existing refs, and opens a draft PR. Its credential needs branch/workflow and PR write access; never provide it to the read-only Action or untrusted PR analysis. Opening the draft may start normal repository CI. A partial response preserves the new branch for inspection rather than deleting uncertain evidence.

The optional audit-repo --add-checks flag writes a new reviewable workflow; the audit itself does not execute it. Only the owner can commit and enable that workflow. Existing CI and native runner placement are preserved.

## Evidence and signing

Dependency suggestions never mark input contracts complete. Full-run feedback can only inhibit normal enforcement gates. Keep observation history owner-controlled; a report digest is not a signature.

Reuse requires a separate owner-controlled coordinator to attest the actual tested checkout, measured runtime and ungated full execution. PR code and dependencies must never have access to its Ed25519 private key. Do not trust unsigned artifacts or a workflow_run trigger alone. Public keys and the hermetic/artifact-free contract come from the target's first parent, before the merged change. New keys cannot authorize their own introducing change. Every observed step must succeed; a skipped step requires fresh validation. The verifier requires a matching complete tree, runtime digest, expected job inventory, unexpired signature and live latest successful PR attempt. Missing evidence runs fresh. Never use reuse for deployment, signing or artifact-producing acceptance gates. See [the complete trust boundary](docs/evidence-and-performance.md).
