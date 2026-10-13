import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "pino";

const NAME = "samebot-tasks";
const MODEL = "claude-opus-5-5";
/** Hard cap per task session, in US cents, follow-ups included. */
const BUDGET_CENTS = "300";
const OUTPUTS_DIR = "/mnt/session/outputs";

const SYSTEM = `You are samebot's task runner. People in a Discord group chat ask samebot for jobs that take real work, and you do them in a Linux sandbox with internet access, Python and the usual tools.

People follow along in a Discord thread, where each message you write between steps is posted. Keep those short and plain: a line on what you're doing or what you found. No headings or preamble.

People may reply in the thread while you work. Treat their messages as steering and follow them.

To share files (charts, spreadsheets, documents, images), save them in ${OUTPUTS_DIR}/. They get attached to your final message. Keep each file under 8MB.

Finish each piece of work with one final message: the result for the group chat. Lead with the answer, keep it to a few sentences or a short list, and use Discord markdown if it helps. Don't ask clarifying questions unless you're truly blocked; make a reasonable assumption and say what you assumed.`;

const TOOLS = [{ type: "agent_toolset_20260401" as const }];

export type SessionEvent = Awaited<
  ReturnType<Anthropic["beta"]["sessions"]["events"]["stream"]>
> extends AsyncIterable<infer E>
  ? E
  : never;

export interface OutputFile {
  id: string;
  name: string;
  size: number;
}

/**
 * Runs long tasks on Claude Managed Agents. The agent and environment are
 * found by name, or created, on first use, and kept in sync with the config
 * above.
 */
export class ManagedAgents {
  private readonly client: Anthropic;
  private setup: Promise<{ agentId: string; environmentId: string }> | undefined;

  constructor(
    apiKey: string,
    private readonly logger: Logger,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async createSession(title: string): Promise<string> {
    const { agentId, environmentId } = await this.ensureSetup();
    const session = await this.client.beta.sessions.create({
      agent: agentId,
      environment_id: environmentId,
      title,
      budget: {
        type: "limit",
        max_list_cost: { amount: BUDGET_CENTS, currency: "USD" },
      },
    });
    return session.id;
  }

  /** Opens the session's event stream. Open it before sending, or events are missed. */
  stream(sessionId: string) {
    return this.client.beta.sessions.events.stream(sessionId);
  }

  async sendMessage(sessionId: string, text: string) {
    await this.client.beta.sessions.events.send(sessionId, {
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    });
  }

  async sessionStatus(sessionId: string) {
    const session = await this.client.beta.sessions.retrieve(sessionId);
    return session.status;
  }

  /** Files the agent saved to its outputs directory. */
  async listOutputFiles(sessionId: string): Promise<OutputFile[]> {
    const files: OutputFile[] = [];
    for await (const file of this.client.beta.files.list({
      scope_id: sessionId,
      betas: ["managed-agents-2026-04-01"],
    })) {
      files.push({ id: file.id, name: file.filename, size: file.size_bytes });
    }
    return files;
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    const response = await this.client.beta.files.download(fileId);
    return Buffer.from(await response.arrayBuffer());
  }

  private ensureSetup() {
    this.setup ??= this.provision().catch((error: unknown) => {
      this.setup = undefined;
      throw error;
    });
    return this.setup;
  }

  private async provision() {
    let agent;
    for await (const candidate of this.client.beta.agents.list()) {
      if (candidate.name === NAME) {
        agent = candidate;
        break;
      }
    }
    if (!agent) {
      agent = await this.client.beta.agents.create({
        name: NAME,
        model: MODEL,
        system: SYSTEM,
        tools: TOOLS,
      });
      this.logger.info({ agentId: agent.id }, "Created task agent");
    } else if (agent.system !== SYSTEM || agent.model.id !== MODEL) {
      agent = await this.client.beta.agents.update(agent.id, {
        version: agent.version,
        model: MODEL,
        system: SYSTEM,
        tools: TOOLS,
      });
      this.logger.info(
        { agentId: agent.id, version: agent.version },
        "Updated task agent",
      );
    }

    let environment;
    for await (const candidate of this.client.beta.environments.list()) {
      if (candidate.name === NAME) {
        environment = candidate;
        break;
      }
    }
    if (!environment) {
      // Unrestricted so tasks can reach any site. The sandbox holds no
      // secrets, so there's nothing in it worth exfiltrating.
      environment = await this.client.beta.environments.create({
        name: NAME,
        config: { type: "cloud", networking: { type: "unrestricted" } },
      });
      this.logger.info(
        { environmentId: environment.id },
        "Created task environment",
      );
    }

    return { agentId: agent.id, environmentId: environment.id };
  }
}
