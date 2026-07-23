# review-automation

Reusable orchestration for a pull-request loop in which native Codex reviews the
current revision and Claude fixes justified findings. The merge gate is the
classic `codex-review` commit status, not a model-authored GitHub approval.

## Behavior

For each open, non-draft pull request:

1. The workflow writes `codex-review=pending` to the current head SHA. Native
   Codex auto-review, configured for every pull-request revision, supplies the
   review.
2. A review from the exact native Codex App account is accepted only when its
   commit matches the pull request's current head.
3. A clean review resolves older Codex conversations and writes
   `codex-review=success`.
4. A review with inline findings writes `codex-review=failure`. For a trusted
   same-repository pull request, Claude evaluates the findings, fixes only the
   justified ones, tests, commits, and pushes.
5. A push starts another review cycle. Claude may run at most ten times for one
   pull request.

Codex is always read-only. Fork pull requests and pull requests from authors
without write-equivalent permission can receive feedback, but can never invoke
the credentialed Claude fix job.

## Target-repository setup

Install the native Codex GitHub App for the repository. Enable native Codex
auto-review and set its trigger to every pull-request revision so every Claude
push receives a fresh review. Then add `CLAUDE_CODE_OAUTH_TOKEN` as a repository
Actions secret.

Copy:

- `templates/agent-review-loop.yml` to
  `.github/workflows/agent-review-loop.yml`;
- the section in `templates/code-review-rules.md` into `AGENTS.md`.

The caller uses the public reusable workflow:

```yaml
uses: jlixfeld/review-automation/.github/workflows/review-loop.yml@v1
```

It passes only the named Claude secret. It does not use `secrets: inherit`.

## Bootstrap command

The command validates that a repository is active and is neither a fork nor
archived. It installs the secret, creates a tracking issue, creates a rollout
branch, updates the caller and review rules, and opens a pull request. It never
changes branch protection.

```bash
node scripts/bootstrap-repo.mjs --repo OWNER/REPOSITORY --dry-run
node scripts/bootstrap-repo.mjs --repo OWNER/REPOSITORY
```

The non-dry run reads `CLAUDE_CODE_OAUTH_TOKEN` from its environment and passes
it to `gh secret set` over standard input. The value is not included in command
arguments or output.

## Publishing `v1`

1. Run `npm test`.
2. Run `actionlint`.
3. Merge the reviewed central implementation.
4. Point `v1` at the verified merge commit.
5. Verify that the public reusable workflow and action can be read at `v1`.

For a canary before `v1` exists or moves, pin both the caller's reusable
workflow reference and its `automation_ref` input to the same immutable central
commit.

## Canary and merge-gate activation

For every repository:

1. Merge the rollout pull request without changing branch protection.
2. Open a canary pull request or push a canary revision.
3. Confirm native Codex auto-review starts without a manual or bot-authored
   mention.
4. Confirm the current SHA transitions through `pending` and then either
   `failure` or `success`.
5. For a finding-bearing review, confirm Claude pushes a tested fix and the new
   revision is reviewed again.
6. Confirm a clean current-head review produces `codex-review=success`.
7. Only then add `codex-review` to the default branch's required status checks.
8. Remove an obsolete required-human-approval gate only when intended. Preserve
   every deterministic check and unrelated protection or ruleset.

The public canary must also prove a fork-originated pull request does not start
the Claude job and receives no Claude credential.

## Failure and rollback

- No Codex response leaves the status pending.
- A stale review is ignored.
- Remaining findings, a Claude failure, the tenth-attempt limit, or an
  orchestration failure leaves the gate failing.
- A review-thread resolution error cannot produce success.
- If native auto-review is disabled or does not run on every revision, stop
  rollout and correct the repository's Codex review settings.

To roll back, first remove `codex-review` from required checks, then remove the
target caller workflow. Existing CI and security checks remain untouched.

## Development

```bash
npm test
GOMODCACHE=/tmp/actionlint-gomod GOCACHE=/tmp/actionlint-cache \
  go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12
```

The implementation has no runtime npm dependencies. Tests use `node:test` and
assert complete GitHub request bodies, workflow contracts, prompts, markers,
status transitions, and the exact ten-attempt boundary.
