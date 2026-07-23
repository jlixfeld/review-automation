import {
  hasMarker,
  isEligibleRequest,
  requestMarker,
  reviewRequestComment,
} from "./orchestrator.mjs";

const REQUEST_ACTIONS = new Set([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
]);

export async function runAction({ env, event, client }) {
  const outputs = emptyOutputs(event);

  if (env.GITHUB_EVENT_NAME === "pull_request_target") {
    return handleRequestEvent({ event, client, outputs });
  }

  return outputs;
}

async function handleRequestEvent({ event, client, outputs }) {
  if (!REQUEST_ACTIONS.has(event.action)) {
    return outputs;
  }

  const prNumber = event.pull_request?.number ?? event.number;
  if (!Number.isInteger(prNumber)) {
    throw new Error("Pull request event is missing a pull request number");
  }

  const pr = await client.getPullRequest(prNumber);
  outputs["pr-number"] = String(pr.number);
  outputs["head-ref"] = pr.head?.ref ?? "";

  if (
    !isEligibleRequest(pr) ||
    event.pull_request?.head?.sha !== pr.head?.sha
  ) {
    return outputs;
  }

  await client.createCommitStatus(
    pr.head.sha,
    "pending",
    `PR #${pr.number} is awaiting the current native Codex review`,
  );

  const comments = await client.listIssueComments(pr.number);
  const marker = requestMarker(pr.number, pr.head.sha);
  if (!hasMarker(comments, marker)) {
    await client.postIssueComment(
      pr.number,
      reviewRequestComment(pr.number, pr.head.sha),
    );
  }

  return outputs;
}

function emptyOutputs(event) {
  const pr = event.pull_request;
  return {
    "should-fix": "false",
    "pr-number": pr?.number === undefined ? "" : String(pr.number),
    "head-ref": pr?.head?.ref ?? "",
    prompt: "",
    attempt: "",
  };
}
