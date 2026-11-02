# Security — 0.1.0

CI Planner analyzes untrusted repository metadata. It must not turn that metadata into privileged execution or successful evidence.

## Report a vulnerability

Use this repository's [private vulnerability reporting](https://github.com/Gamenalyze/ci-planner/security/advisories/new) for a skip bypass, trust-boundary issue, credential exposure or dependency vulnerability. Do not post secrets or private repository snapshots in public issues. No response-time guarantee or paid bounty is offered.

The current 0.1.x line is the initial supported version. Fixes will be released through reviewed commits and versioned releases.

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

There is no hosted backend or telemetry. Git data stays on your machine or runner. Live auditing uses installed gh authentication to GET run/job metadata. It does not request logs, artifacts, source contents or secret values. It retains only listed run/job fields.

Snapshots and plan job names can still reveal private project structure. Treat them as private within your organization. Use read-only contents/Actions permissions. Never pass a write token or extra secrets to a job that checks out untrusted PR code.

Input contracts are owner assertions. Undeclared shared files, external state or an incorrect ignored pattern can make a scope wrong. Start in shadow mode, retain sensitive checks and run periodic full validation.

CI Planner does not sign releases, approve deployment, alter coverage floors or replace privacy/release acceptance gates.
