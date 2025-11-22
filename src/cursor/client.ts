import { type Logger } from "pino";
import { err, ok, type Result } from "neverthrow";

export interface LaunchAgentRequest {
  repository: string;
  instructions: string;
  model: string;
}

export interface AgentStatus {
  id: string;
  name: string;
  status: "CREATING" | "RUNNING" | "FINISHED" | "FAILED";
  source: {
    repository: string;
    ref: string;
  };
  target: {
    branchName: string;
    url: string;
    prUrl?: string;
    autoCreatePr: boolean;
    openAsCursorGithubApp: boolean;
    skipReviewerRequest: boolean;
  };
  summary?: string;
  createdAt: string;
}

export class CursorClient {
  private readonly baseUrl = "https://api.cursor.com/v0";

  constructor(
    private readonly apiKey: string,
    private readonly logger: Logger,
  ) {}

  async launchAgent(
    request: LaunchAgentRequest,
  ): Promise<Result<AgentStatus, Error>> {
    try {
      const authHeader = `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`;
      const response = await fetch(`${this.baseUrl}/agents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify({
          prompt: {
            text: request.instructions,
          },
          source: {
            repository: `https://github.com/${request.repository}`,
            ref: "main",
          },
          target: {
            autoCreatePr: true,
          },
          model: request.model,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          { status: response.status, error: errorText },
          "Failed to launch agent",
        );
        return err(
          new Error(`Cursor API error: ${response.status} - ${errorText}`),
        );
      }

      const data = (await response.json()) as AgentStatus;
      return ok(data);
    } catch (error) {
      this.logger.error({ err: error }, "Error launching agent");
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async getAgentStatus(agentId: string): Promise<Result<AgentStatus, Error>> {
    try {
      const authHeader = `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`;
      const response = await fetch(`${this.baseUrl}/agents/${agentId}`, {
        method: "GET",
        headers: {
          Authorization: authHeader,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          { status: response.status, error: errorText },
          "Failed to get agent status",
        );
        return err(
          new Error(`Cursor API error: ${response.status} - ${errorText}`),
        );
      }

      const data = (await response.json()) as AgentStatus;
      return ok(data);
    } catch (error) {
      this.logger.error({ err: error }, "Error getting agent status");
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async addFollowUp(
    agentId: string,
    instructions: string,
  ): Promise<Result<{ id: string }, Error>> {
    try {
      const authHeader = `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`;
      const response = await fetch(
        `${this.baseUrl}/agents/${agentId}/followup`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: authHeader,
          },
          body: JSON.stringify({
            prompt: {
              text: instructions,
            },
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          { status: response.status, error: errorText },
          "Failed to add follow-up",
        );
        return err(
          new Error(`Cursor API error: ${response.status} - ${errorText}`),
        );
      }

      const data = (await response.json()) as { id: string };
      return ok(data);
    } catch (error) {
      this.logger.error({ err: error }, "Error adding follow-up");
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
