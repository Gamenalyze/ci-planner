# GitHub Actions integration — 0.2.1

Use the [complete workflow example](../examples/pull-request.yml) as a starting point. It targets Node source tests. Preserve your own runner labels, permissions, required checks and release rules.

## Integration contract

- Run the planning job before the jobs it controls.
- Check out the synthetic PR merge with enough history for base and head.
- Pin the CI Planner Action to a reviewed full commit SHA in production.
- Pass trusted GitHub event SHAs through Action inputs.
- Keep planning unprivileged: contents: read, no write token and no extra secrets.
- Run controlled jobs when planning fails, outputs are missing, or a job is absent from the output map.
- Start in shadow mode. Set enforce: 'true' only after the target branch has an enforce policy and the input contracts have been reviewed.

The Action uses the Node.js version already on PATH when it is 22 or newer. It preserves that runtime for later steps in the caller's job. If Node is missing, cannot run, or is older than 22, the Action installs Node.js 24 with setup-node; that fallback changes PATH for later steps too. Use a separate planning job or set up your build runtime after planning if you need an older version. The standalone CLI supports Node.js 22+. The Action installs the single exact parser dependency from its own lockfile with lifecycle scripts disabled. It does not install or execute the PR's dependencies.

## Inputs and outputs

| Input           | Meaning                                                  |
| --------------- | -------------------------------------------------------- |
| base / head     | Required full commit SHAs from the PR event.             |
| merge           | Tested synthetic merge SHA; required to enforce.         |
| workflow        | Required full workflow path whose job IDs are exported.  |
| repository-path | Checkout directory, default .                            |
| enforce         | 'false' by default; a request, not authority on its own. |

Outputs are run (JSON job-ID → boolean), ready, plan-hash and mode. They are generated only after a valid plan. Each job's if condition must use a fail-to-run pattern.

```yaml
needs: plan
if: >-
  ${{ always() && !cancelled() &&
      (needs.plan.outputs.ready != 'true' ||
       fromJSON(needs.plan.outputs.run).test != false) }}
```

A missing test key is not false, so new jobs run. A planner failure leaves ready unset, so the short-circuit condition runs the job. For jobs that already have needs, preserve those dependencies as well as plan. Preserve existing event/branch conditions; this example is only the planning part.

## Required checks

Do not add whole-workflow path filters to required checks. Skipping a whole workflow can leave a required context pending. Keep your aggregate check and make it distinguish intended skips from failed or cancelled selected work. CI Planner does not edit branch protection.

GitHub references: [job dependencies](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-jobs), [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), and [required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

## PR isolation and trust

Use pull_request for untrusted source validation. Do not combine pull_request_target, a write token and PR code execution. CI Planner enforcement refuses events other than pull_request.

The example concurrency group includes repository, PR and source head. Distinct PRs and heads can run at the same time without cancelling each other. Duplicate runs of the same head may cancel older duplicates. The planner itself stores no shared mutable state.

A head policy change cannot opt itself into skipping. Changes to .github or the policy retain full validation. The tested merge verifies the combined state, not just the PR branch.

## Rollback

Set enforce to 'false', change the target branch policy to shadow, or remove job conditions to restore existing CI. Use --force for a local full plan. Schedule full CI independently so unchanged source still receives periodic validation. Do not move native builds to hosted runners to use this product.
