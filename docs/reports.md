# Readable reports — 0.3.0

CI Planner can render its JSON results as GitHub-flavored Markdown and append them to a GitHub job summary. Reports do not change job decisions, publish PR comments, or require a hosted service or model API.

## Commands

JSON remains the default for existing commands:

    ci-planner audit-repo --root /path/to/repo --format markdown
    ci-planner audit --repository OWNER/REPO --workflow ci.yml --format markdown
    ci-planner plan --root /path/to/repo --base BASE_SHA --head HEAD_SHA --format markdown
    ci-planner init --root /path/to/repo --format markdown
    ci-planner fix --root /path/to/repo --format markdown

Save a structured result and render it later:

    ci-planner audit-repo --root /path/to/repo > report.json
    ci-planner report --input report.json > report.md

The report command defaults to Markdown and accepts structured plans, completeness audits, timing reports/snapshots, setup previews and fix receipts. It accepts one regular input file up to 4 MiB and rejects duplicate JSON keys and unsupported report types. Larger audit snapshots can be replayed through audit --input, whose existing input limit is 32 MiB.

## GitHub job summaries

Add --summary to a result command to append Markdown to the file identified by GITHUB_STEP_SUMMARY. Standard output keeps its requested format, so JSON can still be saved as an artifact. The command requires that environment variable when the flag is used.

The Action enables its summary input by default. Set summary: 'false' to suppress it. Set audit-repository: 'true' to include static repository completeness evidence. That audit reads the tested merge commit when supplied, otherwise the exact head commit. Dirty files are ignored.

Example Action inputs:

    summary: 'true'
    audit-repository: 'true'
    enforce: 'false'

See the [complete workflow](../examples/pull-request.yml) for the required source inputs and run-all fallback.

An unavailable optional completeness audit adds an audit warning; it cannot change the planner's decisions or hash. A summary append failure writes a generic warning and leaves the valid structured result available. Missing or invalid planning evidence still fails planning and preserves the existing run-all integration contract.

## Reading the report

- Plans show the actual run/skip decision beside the suggested decision and its reason. In shadow mode, every job runs even when the suggestion says skip.
- Completeness audits show covered, conditional, unverified and missing invocations. Covered means static evidence of a blocking command, not a passing check, meaningful assertions or complete coverage.
- Timing reports show observed worker-minutes and partial observations. Worker time sums concurrent jobs. It is not workflow elapsed time, billed usage or measured savings.
- Setup and fix reports show proposed files/checks and work left for owner review. They distinguish previews, local writes and confirmed draft PR receipts.

The renderer does not invent a savings percentage or convert raw runner time to a dollar estimate. No report grants permission to skip tests.

## Bounds and private information

Tables show at most 50 rows each and report omitted counts. Cells are escaped and limited in length; output is bounded below 96 KiB. HTML, Markdown link syntax, table separators and mentions in display fields cannot inject active markup.

Raw workflow commands and unknown payload properties are not rendered. Paths and check names can still reveal private structure. Keep reports under the repository's access controls. The tool does not claim to redact arbitrary secrets that an owner places inside names or user-supplied JSON fields.

## API

Import renderMarkdown from @gamenalyze/ci-planner/reports. It accepts a supported structured result and returns Markdown without changing that result. markdownCell escapes one bounded display cell. Both functions are annotated in the source.

## Evidence reports

The validate, discover, advise, attest and reuse commands also support JSON, Markdown and GitHub summaries. Reports show failed suggestions, advisory dependency scopes, timing review prompts and explicit fresh/reuse outcomes. Rendering a report never verifies its signature or grants skip authority; use the reuse verifier for that. See [evidence and performance](evidence-and-performance.md).
