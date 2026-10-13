import { type Logger } from "pino";
import { err, ok, type Result } from "neverthrow";

export interface LaunchAgentRequest {
  repository: string;
  instructions: string;
  model: string;
}

/** Status of an agent's latest run, flattened from the v1 agent + run. */
export interface AgentStatus {
  id: string;
  status: "CREATING" | "RUNNING" | "FINISHED" | "FAILED";
  prUrl?: string;
  summary?: string;
}

type RunStatus =
  | "CREATING"
  | "RUNNING"
  | "FINISHED"
  | "ERROR"
  | "CANCELLED"
  | "EXPIRED";

interface Run {
  id: string;
  status: RunStatus;
  result?: string;
  git?: { branches?: Array<{ prUrl?: string }> };
}

interface Agent {
  id: string;
  latestRunId?: string;
  repos?: Array<{ prUrl?: string }>;
}

export class CursorClient {
  private readonly baseUrl = "https://api.cursor.com/v1";

  constructor(
    private readonly apiKey: string,
    private readonly logger: Logger,
  ) {}

  async launchAgent(
    request: LaunchAgentRequest,
  ): Promise<Result<AgentStatus, Error>> {
    const result = await this.request<{ agent: Agent; run: Run }>(
      "POST",
      "/agents",
      {
        prompt: { text: request.instructions },
        repos: [
          {
            url: `https://github.com/${request.repository}`,
            startingRef: "main",
          },
        ],
        autoCreatePR: true,
        model: { id: request.model },
      },
      "launch agent",
    );
    return result.map(({ agent, run }) => toAgentStatus(agent.id, run));
  }

  async getAgentStatus(agentId: string): Promise<Result<AgentStatus, Error>> {
    const agentResult = await this.request<Agent>(
      "GET",
      `/agents/${agentId}`,
      undefined,
      "get agent",
    );
    if (agentResult.isErr()) {
      return err(agentResult.error);
    }
    const runId = agentResult.value.latestRunId;
    if (!runId) {
      return ok({ id: agentId, status: "CREATING" });
    }
    const runResult = await this.request<Run>(
      "GET",
      `/agents/${agentId}/runs/${runId}`,
      undefined,
      "get agent run",
    );
    return runResult.map((run) => {
      const status = toAgentStatus(agentId, run);
      // Runs don't always carry the PR link; the agent's repo entry does.
      const agentPrUrl = agentResult.value.repos?.find(
        (repo) => repo.prUrl,
      )?.prUrl;
      if (!status.prUrl && agentPrUrl) {
        status.prUrl = agentPrUrl;
      }
      return status;
    });
  }

  async addFollowUp(
    agentId: string,
    instructions: string,
  ): Promise<Result<{ id: string }, Error>> {
    const result = await this.request<Run>(
      "POST",
      `/agents/${agentId}/runs`,
      { prompt: { text: instructions } },
      "add follow-up",
    );
    return result.map((run) => ({ id: run.id }));
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    operation: string,
  ): Promise<Result<T, Error>> {
    try {
      const authHeader = `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`;
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: authHeader,
          ...(body !== undefined && { "Content-Type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          { status: response.status, error: errorText },
          `Failed to ${operation}`,
        );
        return err(
          new Error(`Cursor API error: ${response.status} - ${errorText}`),
        );
      }

      return ok((await response.json()) as T);
    } catch (error) {
      this.logger.error({ err: error }, `Error trying to ${operation}`);
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function toAgentStatus(agentId: string, run: Run): AgentStatus {
  const status: AgentStatus = {
    id: agentId,
    status:
      run.status === "CREATING" ||
      run.status === "RUNNING" ||
      run.status === "FINISHED"
        ? run.status
        : "FAILED",
  };
  const prUrl = run.git?.branches?.find((branch) => branch.prUrl)?.prUrl;
  if (prUrl) {
    status.prUrl = prUrl;
  }
  if (run.result) {
    status.summary = run.result;
  }
  return status;
}
