# Scoped Claude remediation permissions

## Goal

Let the reusable review-loop workflow remediate justified Codex findings without granting
Claude blanket shell access or bypassing its permission model.

## Evidence

The StratBacktester canary reached the Claude fix job, but the action reported repeated
permission denials and completed without editing, testing, committing, or pushing the
justified boundary fix.

## Design

The reusable `fix` job will pass a `claude_args` allow-list to the pinned Claude Code
action. The allow-list grants only:

- `Edit` and `Write` for repository files.
- Git inspection and publishing commands: `status`, `diff`, `log`, `show`, `add`,
  `commit`, and `push`.
- `uv run` for the repository's tests and lint checks.
- Read-only shell inspection commands: `rg`, `sed`, `cat`, `ls`, and `pwd`.

It will not enable `--dangerously-skip-permissions`, allow arbitrary `Bash`, weaken the
internal-branch guard, or change the explicit native-Codex-bot allow-list.

## Verification

- Extend the workflow contract test to require the allow-list and reject blanket bypass
  mode or arbitrary shell permission.
- Run the repository test suite and actionlint.
- Move the reusable action tag only after the implementation PR is merged.
- Re-run the disposable StratBacktester canary. Success requires: Codex inline finding,
  Claude source-and-test fix commit, a new automatic Codex review, resolved prior Codex
  threads, and a successful `codex-review` status.
