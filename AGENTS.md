# Repository instructions

## Code Review Rules

- Review intended behavior, not only the diff. Before writing a PR, put its goal,
  acceptance criteria, governing contract links, constraints/intentional choices,
  actual validation and known gaps in the PR description. During review, compare
  those requirements with changed code, callers, consumers and relevant tests;
  flag concrete contract or compatibility violations. Private chat history and a
  previous bot approval are not evidence. Name unavailable material context.
- Trace trust and evidence end to end. Flag a decision authorized by PR-controlled
  configuration, another repository/run/plan, skipped or incomplete validation,
  or missing identity/provenance where trusted base/runtime evidence is required.
  The safe path preserves the documented trust source and fails closed on unknown
  evidence. Establish the actual triggering scenario before reporting a defect.
- Check realistic boundaries and output consumers. For changed I/O, parsers or
  renderers, inspect normal large inputs, aggregate limits, failure diagnostics,
  and untrusted values reaching Markdown/HTML/URLs/commands. Compare behavior with
  documentation and tests. Use a targeted, credential-free reproduction when the
  review environment permits; distinguish executed evidence from source tracing.

For each finding, give the location, scenario, consequence and evidence. Preserve
repository severity/merge policy; do not hide a material defect merely because it
is non-blocking, or inflate severity to bypass an interface's reporting filter.
Do not claim tests/reproductions ran when they did not. A clean automated review
does not establish that untested scenarios are safe. Respect native-build, secret,
data-access and release restrictions while reviewing.
