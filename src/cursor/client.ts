import { type Logger } from "pino";
import { err, ok, type Result } from "neverthrow";

export interface LaunchAgentRequest {
  repository: string;
  branch?: string;
  instructions: string;
  model?: string;
}

export interface AgentStatus {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  prUrl?: string;
  error?: string;
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
    try {
      const response = await fetch(`${this.baseUrl}/agents/launch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          repository: request.repository,
          branch: request.branch,
          instructions: request.instructions,
          model: request.model ?? "composer",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          { status: response.status, error: errorText },
          "Failed to launch agent",
        );
        return err(
          new Error(
            `Cursor API error: ${response.status} - ${errorText}`,
          ),
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
      const response = await fetch(`${this.baseUrl}/agents/${agentId}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          { status: response.status, error: errorText },
          "Failed to get agent status",
        );
        return err(
          new Error(
            `Cursor API error: ${response.status} - ${errorText}`,
          ),
        );
      }

      const data = (await response.json()) as AgentStatus;
      return ok(data);
    } catch (error) {
      this.logger.error({ err: error }, "Error getting agent status");
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
