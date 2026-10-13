import { Agent, type Run, type RunResult } from "@cursor/sdk";
import { type Logger } from "pino";
import { ResultAsync } from "neverthrow";

const MODEL = { id: "claude-opus-5-5" };

export interface AgentSummary {
  agentId: string;
  name: string;
  status: string;
  prUrl?: string;
}

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

  waitForRun(run: Run): ResultAsync<RunResult, Error> {
    return this.attempt("wait for run", () => run.wait());
  }

  /** Recent agents on this repo, newest first, with their latest PR link. */
  listAgents(limit = 8): ResultAsync<AgentSummary[], Error> {
    return this.attempt("list agents", async () => {
      const { items } = await Agent.list({
        runtime: "cloud",
        apiKey: this.apiKey,
        limit: 25,
      });
      const ours = items
        .filter(
          (agent) =>
            agent.runtime === "cloud" &&
            agent.repos?.some((repo) => repo.includes(this.repository)),
        )
        .slice(0, limit);
      return Promise.all(
        ours.map(async (agent) => {
          const run = await this.latestRun(agent.agentId);
          const summary: AgentSummary = {
            agentId: agent.agentId,
            name: agent.name,
            status: run?.status ?? agent.status ?? "unknown",
          };
          const prUrl = run?.git?.branches.find((branch) => branch.prUrl)?.prUrl;
          if (prUrl) {
            summary.prUrl = prUrl;
          }
          return summary;
        }),
      );
    });
  }

  /** Cancels the agent's run if one is in progress. Returns whether it was. */
  cancelAgent(agentId: string): ResultAsync<boolean, Error> {
    return this.attempt("cancel agent", async () => {
      const run = await this.latestRun(agentId);
      if (!run || run.status !== "running") {
        return false;
      }
      await Agent.cancelRun(run.id, {
        runtime: "cloud",
        agentId,
        apiKey: this.apiKey,
      });
      return true;
    });
  }

  private async latestRun(agentId: string): Promise<Run | undefined> {
    const { items } = await Agent.listRuns(agentId, {
      runtime: "cloud",
      apiKey: this.apiKey,
      limit: 1,
    });
    return items[0];
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
