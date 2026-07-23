import { CODEX_REVIEW_CONTEXT } from "./constants.mjs";

const API_ROOT = "https://api.github.com";

export const REVIEW_THREADS_QUERY = `
query ReviewThreads(
  $owner: String!
  $name: String!
  $number: Int!
  $cursor: String
) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes {
              author {
                login
              }
              pullRequestReview {
                id
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}`.trim();

export const RESOLVE_THREAD_MUTATION = `
mutation ResolveReviewThread($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread {
      id
      isResolved
    }
  }
}`.trim();

export class GitHubClient {
  constructor({ token, repository, fetchImpl = fetch }) {
    if (!token) {
      throw new Error("GitHub token is required");
    }

    const [owner, name, extra] = repository?.split("/") ?? [];
    if (!owner || !name || extra) {
      throw new Error("Repository must use OWNER/REPO format");
    }

    this.token = token;
    this.repository = repository;
    this.owner = owner;
    this.name = name;
    this.fetchImpl = fetchImpl;
  }

  async getPullRequest(prNumber) {
    return this.#rest("GET", `/repos/${this.repository}/pulls/${prNumber}`);
  }

  async getCollaboratorPermission(login) {
    const result = await this.#rest(
      "GET",
      `/repos/${this.repository}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    if (typeof result?.permission !== "string") {
      throw new Error("GitHub collaborator permission response is missing permission");
    }
    return result.permission;
  }

  async listIssueComments(prNumber) {
    return this.#restPaginate(
      `/repos/${this.repository}/issues/${prNumber}/comments`,
    );
  }

  async postIssueComment(prNumber, body) {
    return this.#rest(
      "POST",
      `/repos/${this.repository}/issues/${prNumber}/comments`,
      { body },
    );
  }

  async createCommitStatus(sha, state, description) {
    return this.#rest("POST", `/repos/${this.repository}/statuses/${sha}`, {
      state,
      context: CODEX_REVIEW_CONTEXT,
      description,
    });
  }

  async listReviewComments(prNumber, reviewId) {
    return this.#restPaginate(
      `/repos/${this.repository}/pulls/${prNumber}/reviews/${reviewId}/comments`,
    );
  }

  async listReviewThreads(prNumber) {
    const threads = [];
    let cursor = null;

    do {
      const data = await this.#graphql(REVIEW_THREADS_QUERY, {
        owner: this.owner,
        name: this.name,
        number: prNumber,
        cursor,
      });
      const connection =
        data?.repository?.pullRequest?.reviewThreads;
      if (
        !Array.isArray(connection?.nodes) ||
        typeof connection?.pageInfo?.hasNextPage !== "boolean"
      ) {
        throw new Error(
          "GitHub GraphQL response is missing pull request review threads",
        );
      }

      threads.push(...connection.nodes);
      cursor = connection.pageInfo.hasNextPage
        ? connection.pageInfo.endCursor
        : null;
      if (connection.pageInfo.hasNextPage && !cursor) {
        throw new Error(
          "GitHub GraphQL review thread pagination is missing an end cursor",
        );
      }
    } while (cursor);

    return threads;
  }

  async resolveReviewThread(threadId) {
    const data = await this.#graphql(RESOLVE_THREAD_MUTATION, { threadId });
    const thread = data?.resolveReviewThread?.thread;
    if (thread?.id !== threadId || thread?.isResolved !== true) {
      throw new Error(`GitHub did not resolve review thread ${threadId}`);
    }
    return thread;
  }

  async #restPaginate(path) {
    const items = [];
    let page = 1;

    while (true) {
      const separator = path.includes("?") ? "&" : "?";
      const result = await this.#rest(
        "GET",
        `${path}${separator}per_page=100&page=${page}`,
      );
      if (!Array.isArray(result)) {
        throw new Error(`GitHub REST pagination response for ${path} is not an array`);
      }
      items.push(...result);
      if (result.length < 100) {
        return items;
      }
      page += 1;
    }
  }

  async #rest(method, path, body) {
    const options = {
      method,
      headers: this.#headers(),
    };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(`${API_ROOT}${path}`, options);
    if (!response.ok) {
      throw new Error(
        `GitHub REST ${method} ${path} failed: ${response.status} ${response.statusText}`,
      );
    }
    return response.json();
  }

  async #graphql(query, variables) {
    const response = await this.fetchImpl(`${API_ROOT}/graphql`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new Error(
        `GitHub GraphQL HTTP request failed: ${response.status} ${response.statusText}`,
      );
    }

    const result = await response.json();
    if (Array.isArray(result?.errors) && result.errors.length > 0) {
      throw new Error(
        `GitHub GraphQL failed: ${result.errors
          .map((error) => error.message)
          .join("; ")}`,
      );
    }
    if (!result || typeof result.data !== "object" || result.data === null) {
      throw new Error("GitHub GraphQL response is missing data");
    }
    return result.data;
  }

  #headers() {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "User-Agent": "jlixfeld-review-automation",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }
}
