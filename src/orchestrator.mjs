import {
  AUTOMATION_LOGIN,
  MARKER_PREFIX,
  MAX_FIX_ATTEMPTS,
} from "./constants.mjs";

const TRUSTED_PERMISSIONS = new Set(["admin", "maintain", "write"]);
const FOOTER = "- Codex";

export function requestMarker(prNumber, headSha) {
  return marker("request", prNumber, headSha);
}

export function handledReviewMarker(reviewNodeId, headSha) {
  return marker("handled", reviewNodeId, headSha);
}

export function attemptMarker(prNumber, attempt) {
  return marker("attempt", prNumber, attempt);
}

export function limitMarker(prNumber, maxAttempts) {
  return marker("limit", prNumber, maxAttempts);
}

export function markerComment(hiddenMarker) {
  return `${hiddenMarker}\n\n${FOOTER}`;
}

export function markersComment(hiddenMarkers) {
  return `${hiddenMarkers.join("\n")}\n\n${FOOTER}`;
}

export function reviewRequestComment(prNumber, headSha) {
  return `@codex review\n\n${requestMarker(prNumber, headSha)}\n\n${FOOTER}`;
}

export function hasMarker(comments, expectedMarker) {
  return comments.some((comment) => {
    return (
      isAutomationComment(comment) &&
      comment.body.includes(expectedMarker)
    );
  });
}

export function parseAttemptCount(
  commentBodies,
  prNumber,
  maxAttempts = MAX_FIX_ATTEMPTS,
) {
  const attempts = new Set();
  const pattern = new RegExp(
    `<!-- ${escapeRegExp(MARKER_PREFIX)}:attempt:${prNumber}:(\\d+) -->`,
    "g",
  );

  for (const comment of commentBodies) {
    if (!isAutomationComment(comment)) {
      continue;
    }
    const body = comment.body;

    for (const match of body.matchAll(pattern)) {
      const attempt = Number.parseInt(match[1], 10);
      if (attempt >= 1 && attempt <= maxAttempts) {
        attempts.add(attempt);
      }
    }
  }

  return attempts.size;
}

export function canStartFixAttempt(completedAttempts, maxAttempts) {
  if (
    !Number.isInteger(completedAttempts) ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    completedAttempts < 0 ||
    completedAttempts >= maxAttempts
  ) {
    return { allowed: false, attempt: null };
  }

  return { allowed: true, attempt: completedAttempts + 1 };
}

export function isEligibleRequest(pr) {
  return pr?.state === "open" && pr?.draft === false;
}

export function isEligibleFix({
  pr,
  authorPermission,
  review,
  currentHeadSha,
  findingCount,
}) {
  return (
    isEligibleRequest(pr) &&
    sameText(pr?.head?.repo?.full_name, pr?.base?.repo?.full_name) &&
    TRUSTED_PERMISSIONS.has(authorPermission?.toLowerCase()) &&
    pr?.head?.sha === currentHeadSha &&
    review?.commit_id === currentHeadSha &&
    Number.isInteger(findingCount) &&
    findingCount > 0
  );
}

export function selectCodexThreadsToResolve({
  threads,
  codexLogin,
  clean,
}) {
  if (!clean) {
    return [];
  }

  return threads
    .filter((thread) => {
      if (thread?.isResolved) {
        return false;
      }

      const root = thread?.comments?.nodes?.[0];
      if (!sameText(root?.author?.login, codexLogin)) {
        return false;
      }

      return true;
    })
    .map((thread) => thread.id);
}

export function buildClaudePrompt({
  repository,
  prNumber,
  reviewUrl,
  attempt,
  maxAttempts,
}) {
  return [
    `Address the latest native Codex review for ${repository} pull request #${prNumber}.`,
    `Review: ${reviewUrl}`,
    `This is fix attempt ${attempt} of ${maxAttempts}.`,
    "",
    "Read the review summary and every unresolved inline finding from that latest Codex review. Evaluate each finding technically; do not accept it automatically. Implement only justified fixes, and explain unsupported findings in your progress comment.",
    "",
    "For every behavior change, add or update a test that would have caught the problem. Run the repository's documented verification commands. Keep unrelated code unchanged. Commit and push the verified changes to the existing pull-request branch. If no code changes are justified, explain the rebuttal, then create and push an empty commit so the current conclusion receives a fresh Codex review. Do not create a new pull request and do not merge.",
  ].join("\n");
}

export function manualInterventionComment({ prNumber, maxAttempts }) {
  return [
    `Codex findings remain after ${maxAttempts} Claude fix attempts. The \`codex-review\` gate will stay failing until a new revision receives a clean Codex review. Manual intervention is required.`,
    "",
    limitMarker(prNumber, maxAttempts),
    "",
    FOOTER,
  ].join("\n");
}

function marker(kind, ...parts) {
  return `<!-- ${MARKER_PREFIX}:${kind}:${parts.join(":")} -->`;
}

function sameText(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left.toLowerCase() === right.toLowerCase()
  );
}

function isAutomationComment(comment) {
  return (
    typeof comment?.body === "string" &&
    sameText(comment?.user?.login, AUTOMATION_LOGIN)
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
