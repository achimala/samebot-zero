import { Octokit } from "@octokit/rest";
import { ResultAsync } from "neverthrow";

const OWNER = "achimala";
const REPOSITORY_NAME = "samebot-zero";
export const REPOSITORY = `${OWNER}/${REPOSITORY_NAME}`;
/** Coding agents push to branches under this prefix. */
const AGENT_BRANCH_PREFIX = "cursor/";

export interface AgentPullRequest {
  number: number;
  title: string;
  url: string;
  branch: string;
  draft: boolean;
}

/** Open PRs from coding agents. The repo is public, so no token is needed. */
export function listAgentPullRequests(): ResultAsync<AgentPullRequest[], Error> {
  return attempt(async () => {
    const { data } = await new Octokit().pulls.list({
      owner: OWNER,
      repo: REPOSITORY_NAME,
      state: "open",
      per_page: 50,
    });
    return data
      .filter((pullRequest) =>
        pullRequest.head.ref.startsWith(AGENT_BRANCH_PREFIX),
      )
      .map((pullRequest) => ({
        number: pullRequest.number,
        title: pullRequest.title,
        url: pullRequest.html_url,
        branch: pullRequest.head.ref,
        draft: pullRequest.draft ?? false,
      }));
  });
}

/** Marks a draft ready for review if needed, then squash-merges it. */
export function mergePullRequest(
  githubToken: string,
  pullNumber: number,
): ResultAsync<void, Error> {
  return attempt(async () => {
    const octokit = new Octokit({ auth: githubToken });
    const pullRequest = await getOpenAgentPullRequest(octokit, pullNumber);
    if (pullRequest.draft) {
      await octokit.graphql(
        `mutation($pullRequestId: ID!) {
          markPullRequestReadyForReview(input: {pullRequestId: $pullRequestId}) {
            pullRequest { id }
          }
        }`,
        { pullRequestId: pullRequest.node_id },
      );
    }
    await octokit.pulls.merge({
      owner: OWNER,
      repo: REPOSITORY_NAME,
      pull_number: pullNumber,
      merge_method: "squash",
    });
  });
}

/** Closes the PR without merging and deletes its branch. */
export function closePullRequest(
  githubToken: string,
  pullNumber: number,
): ResultAsync<void, Error> {
  return attempt(async () => {
    const octokit = new Octokit({ auth: githubToken });
    const pullRequest = await getOpenAgentPullRequest(octokit, pullNumber);
    await octokit.pulls.update({
      owner: OWNER,
      repo: REPOSITORY_NAME,
      pull_number: pullNumber,
      state: "closed",
    });
    await octokit.git.deleteRef({
      owner: OWNER,
      repo: REPOSITORY_NAME,
      ref: `heads/${pullRequest.head.ref}`,
    });
  });
}

export function pullNumberFromUrl(url: string): number | null {
  const match = url.match(/\/pull\/(\d+)$/);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

async function getOpenAgentPullRequest(octokit: Octokit, pullNumber: number) {
  const { data: pullRequest } = await octokit.pulls.get({
    owner: OWNER,
    repo: REPOSITORY_NAME,
    pull_number: pullNumber,
  });
  if (pullRequest.state !== "open") {
    throw new Error(`PR #${pullNumber} is already ${pullRequest.merged ? "merged" : "closed"}`);
  }
  if (!pullRequest.head.ref.startsWith(AGENT_BRANCH_PREFIX)) {
    throw new Error(`PR #${pullNumber} wasn't opened by a coding agent`);
  }
  return pullRequest;
}

function attempt<T>(action: () => Promise<T>): ResultAsync<T, Error> {
  return ResultAsync.fromPromise(action(), (error) =>
    error instanceof Error ? error : new Error(String(error)),
  );
}
