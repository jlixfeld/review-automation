## Code Review Rules

When reviewing a pull request:

- Keep the review strictly read-only. Do not edit files, commit, push, or otherwise modify the pull-request branch.
- Review the complete diff and enough surrounding code to verify every finding.
- Read existing review comments first and do not duplicate them.
- Post only high-confidence, actionable findings introduced by the pull request.
- Every finding must identify a concrete failure scenario, explain its impact, and cite the relevant file and line.
- Do not post style preferences, speculative concerns, pre-existing problems, or issues that ordinary CI already catches.
- Post every blocking finding as an inline GitHub review comment; never put a blocking finding only in the review summary. If there are no findings, post one concise clean-review summary.

When re-reviewing a pull request:

- Read all previous Codex findings, author replies, and subsequent commits.
- Verify every previous finding against the latest revision; do not accept an author's claim without checking the code and tests.
- Resolve an inline Codex conversation only after the underlying issue is demonstrably fixed or a technically supported rebuttal establishes that no fix is required.
- Leave unresolved findings open, and post new high-confidence issues in separate conversations.
- If everything is resolved, post one concise summary confirming that the previous findings were verified and no blocking findings remain.
- Keep the re-review strictly read-only. Do not edit, commit, or push.
