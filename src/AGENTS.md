# CI Planner source review rules

## Code Review Rules

- Reuse may authorize a skip only from an independently trusted pre-push/base
  contract and keys, never from the PR/target tree under evaluation. Trace the
  trusted caller before/after/repository binding and first-parent check; a
  multi-commit push or missing/mismatched evidence must run fresh. Successful jobs
  with skipped, cancelled, failed or missing required test steps are not full runs.
- Validation/reuse evidence must match its repository, workflow, exact plan/policy
  and run identity where the contract requires them. A matching policy hash alone
  cannot establish report provenance. Check missing, wrong-repository and wrong-
  plan cases, plus the valid same-plan case, against the documented fallback.
- Discovery must tolerate normal lockfiles/generated sources larger than 256 KiB
  as explicitly partial inputs within total byte/time budgets; do not mislabel
  size-limit failures as missing Git history. Trace every untrusted report/fix-PR
  value to its rendered sink: validate numeric counts, escape Markdown/HTML, and
  distinguish GitHub bare-URL autolinks from injected images or HTML. Check a
  normal value as well as a malicious/boundary value before raising a finding.
