import {
  Agent,
  type Run,
  type RunResult,
  type SDKAgentInfo,
} from "@cursor/sdk";
import { type Logger } from "pino";
import { ResultAsync } from "neverthrow";

const MODEL = { id: "claude-opus-5-5" };

export interface StartedRun {
  agentId: string;
  run: Run;
}

/** Cloud agents on one GitHub repo, via the Cursor SDK. */
export class CursorClient {
  constructor(
    private readonly apiKey: string,
    private readonly repository: string,
    private readonly logger: Logger,
  ) {}

  /** Creates a cloud agent on main that opens a PR when it finishes. */
  launchAgent(instructions: string): ResultAsync<StartedRun, Error> {
    return this.attempt("launch agent", async () => {
      const agent = await Agent.create({
        apiKey: this.apiKey,
        model: MODEL,
        cloud: {
          repos: [
            {
              url: `https://github.com/${this.repository}`,
              startingRef: "main",
            },
          ],
          autoCreatePR: true,
        },
      });
      const run = await agent.send(instructions);
      return { agentId: agent.agentId, run };
    });
  }

  /** Sends follow-up instructions to an existing agent as a new run. */
  addFollowUp(
    agentId: string,
    instructions: string,
  ): ResultAsync<StartedRun, Error> {
    return this.attempt("add follow-up", async () => {
      const agent = await Agent.resume(agentId, {
        apiKey: this.apiKey,
        model: MODEL,
      });
      const run = await agent.send(instructions);
      return { agentId, run };
    });
  }

  /** The most recent agents on this repo, newest first. */
  listAgents(): ResultAsync<SDKAgentInfo[], Error> {
    return this.attempt("list agents", async () => {
      const { items } = await Agent.list({
        runtime: "cloud",
        apiKey: this.apiKey,
        limit: 20,
      });
      return items.filter(
        (agent) =>
          agent.runtime === "cloud" &&
          (agent.repos ?? []).some((repo) => repo.includes(this.repository)),
      );
    });
  }

  /** Cancels every run of the agent that is still going. Returns how many. */
  cancelAgent(agentId: string): ResultAsync<number, Error> {
    return this.attempt("cancel agent", async () => {
      const { items } = await Agent.listRuns(agentId, {
        runtime: "cloud",
        apiKey: this.apiKey,
      });
      const runningRuns = items.filter((run) => run.status === "running");
      await Promise.all(runningRuns.map((run) => run.cancel()));
      return runningRuns.length;
    });
  }

  waitForRun(run: Run): ResultAsync<RunResult, Error> {
    return this.attempt("wait for run", () => run.wait());
  }

  private attempt<T>(
    operation: string,
    action: () => Promise<T>,
  ): ResultAsync<T, Error> {
    return ResultAsync.fromPromise(action(), (error) => {
      this.logger.error({ err: error }, `Cursor: failed to ${operation}`);
      return error instanceof Error ? error : new Error(String(error));
    });
  }
}

export function prUrlOf(result: RunResult): string | undefined {
  return result.git?.branches.find((branch) => branch.prUrl)?.prUrl;
}
