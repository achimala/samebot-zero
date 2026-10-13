import {
  AttachmentBuilder,
  ThreadAutoArchiveDuration,
  type Message,
  type ThreadChannel,
} from "discord.js";
import type { Feature, RuntimeContext } from "../core/runtime";
import { chunkMessage } from "../discord/messenger";
import {
  ManagedAgents,
  type SessionEvent,
} from "../tasks/managed-agents";

const TOOL_FLUSH_MS = 8000;
const TYPING_INTERVAL_MS = 8000;
const MAX_STREAM_RECONNECTS = 5;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

interface Task {
  sessionId: string;
  title: string;
  thread: ThreadChannel;
  /** The chat message that asked for the task; results reply to it. */
  origin: Message;
  running: boolean;
  /** Only the first turn's result goes back to the main channel. */
  turns: number;
  sentFileIds: Set<string>;
}

type TurnEnd =
  | { kind: "done"; text: string }
  | { kind: "failed"; reason: string };

/**
 * Long-running tasks on Claude Managed Agents. Each task works in a thread
 * off the message that asked for it: progress posts there, replies in the
 * thread steer it, and the result comes back to the main channel.
 */
export class TaskFeature implements Feature {
  private ctx!: RuntimeContext;
  private agents!: ManagedAgents;
  /** Keyed by thread ID. In memory, so tasks stop reporting on redeploy. */
  private readonly tasks = new Map<string, Task>();

  register(context: RuntimeContext): void {
    this.ctx = context;
    this.agents = new ManagedAgents(
      context.config.anthropicApiKey,
      context.logger,
    );
    context.discord.on("messageCreate", (message) => {
      void this.handleThreadReply(message);
    });
  }

  isTaskThread(channelId: string): boolean {
    return this.tasks.has(channelId);
  }

  /** Starts a task in a new thread off `originMessageId` and returns at once. */
  async startTask(
    channelId: string,
    originMessageId: string,
    title: string,
    prompt: string,
  ): Promise<string> {
    try {
      const channel = await this.ctx.discord.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || channel.isDMBased() || channel.isThread()) {
        return "Tasks only work in a regular server channel, not DMs or threads.";
      }
      const origin = await channel.messages.fetch(originMessageId);
      const thread = await origin.startThread({
        name: title.slice(0, 100),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      });
      const sessionId = await this.agents.createSession(title);

      const task: Task = {
        sessionId,
        title,
        thread,
        origin,
        running: false,
        turns: 0,
        sentFileIds: new Set(),
      };
      this.tasks.set(thread.id, task);
      await origin.react("⏳").catch(() => undefined);
      this.ctx.logger.info({ sessionId, threadId: thread.id, title }, "Started task");

      void this.runTurn(task, prompt);
      return `Started the task in a thread called "${title}". Progress posts there and the result comes back here; don't repeat this.`;
    } catch (error) {
      this.ctx.logger.error({ err: error }, "Failed to start task");
      return "Failed to start the task.";
    }
  }

  private async handleThreadReply(message: Message) {
    if (message.author.bot || message.system) {
      return;
    }
    const task = this.tasks.get(message.channelId);
    if (!task) {
      return;
    }
    const text = `${message.member?.displayName ?? message.author.username}: ${message.content}`;
    if (task.running) {
      // Mid-turn messages steer the running agent.
      await this.agents.sendMessage(task.sessionId, text).catch((error: unknown) => {
        this.ctx.logger.warn({ err: error }, "Failed to steer task");
      });
      return;
    }
    await this.runTurn(task, text);
  }

  /** Sends one message to the session and reports until it goes idle. */
  private async runTurn(task: Task, text: string) {
    task.running = true;
    task.turns++;
    const typing = setInterval(() => {
      void task.thread.sendTyping().catch(() => undefined);
    }, TYPING_INTERVAL_MS);
    void task.thread.sendTyping().catch(() => undefined);

    let end: TurnEnd;
    try {
      end = await this.followTurn(task, text);
    } catch (error) {
      this.ctx.logger.error({ err: error, sessionId: task.sessionId }, "Task turn failed");
      end = { kind: "failed", reason: "lost track of the task" };
    } finally {
      clearInterval(typing);
      task.running = false;
    }
    await this.reportTurnEnd(task, end);
  }

  private async followTurn(task: Task, text: string): Promise<TurnEnd> {
    const progress = new ProgressFeed(task.thread);
    let lastText = "";
    let sent = false;

    for (let attempt = 0; attempt <= MAX_STREAM_RECONNECTS; attempt++) {
      const stream = await this.agents.stream(task.sessionId);
      try {
        if (!sent) {
          await this.agents.sendMessage(task.sessionId, text);
          sent = true;
        } else if ((await this.agents.sessionStatus(task.sessionId)) === "idle") {
          // The turn ended while we were reconnecting.
          await progress.flush();
          return { kind: "done", text: lastText };
        }

        for await (const event of stream) {
          const end = await this.handleEvent(event, progress, (value) => {
            lastText = value;
          });
          if (end) {
            await progress.flush();
            return end.kind === "done" ? { kind: "done", text: lastText } : end;
          }
        }
      } finally {
        stream.controller.abort();
      }
      this.ctx.logger.warn({ sessionId: task.sessionId, attempt }, "Task stream closed; reconnecting");
    }
    await progress.flush();
    return { kind: "failed", reason: "lost the connection to the task" };
  }

  /** Returns how the turn ended, or null while it's still going. */
  private async handleEvent(
    event: SessionEvent,
    progress: ProgressFeed,
    setLastText: (text: string) => void,
  ): Promise<TurnEnd | null> {
    switch (event.type) {
      case "agent.message": {
        const text = event.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("")
          .trim();
        if (text) {
          setLastText(text);
          await progress.flush();
          await progress.post(text);
        }
        return null;
      }
      case "agent.tool_use":
        progress.addStep(describeToolUse(event.name, event.input));
        return null;
      case "session.error":
        this.ctx.logger.warn({ error: event.error }, "Task session error");
        return null;
      case "session.status_terminated":
        return { kind: "failed", reason: "the task's session ended unexpectedly" };
      case "session.status_idle":
        switch (event.stop_reason.type) {
          case "end_turn":
            return { kind: "done", text: "" };
          case "requires_action":
            return null;
          case "budget_reached":
            return { kind: "failed", reason: "it hit its spending limit" };
          case "refusal":
            return { kind: "failed", reason: "the model declined to do it" };
          default:
            return { kind: "failed", reason: "it kept hitting errors" };
        }
      default:
        return null;
    }
  }

  private async reportTurnEnd(task: Task, end: TurnEnd) {
    const files = end.kind === "done" ? await this.collectFiles(task) : [];
    const firstTurn = task.turns === 1;

    if (end.kind === "failed") {
      await task.thread.send(`stopped: ${end.reason}`).catch(() => undefined);
    } else if (!firstTurn && files.length > 0) {
      await task.thread.send({ files }).catch(() => undefined);
    }

    if (!firstTurn) {
      return;
    }

    await task.origin.reactions.cache
      .get("⏳")
      ?.users.remove(this.ctx.discord.user?.id)
      .catch(() => undefined);
    await task.origin.react(end.kind === "done" ? "✅" : "❌").catch(() => undefined);

    const body =
      end.kind === "done"
        ? end.text || "done."
        : `couldn't finish "${task.title}": ${end.reason}.`;
    const channel = task.origin.channel;
    const chunks = chunkMessage(`${body}\n-# ${task.thread.url}`);
    for (const [index, chunk] of chunks.entries()) {
      const last = index === chunks.length - 1;
      const payload = { content: chunk, ...(last && files.length > 0 && { files }) };
      try {
        if (index === 0) {
          await task.origin.reply(payload);
        } else if (channel.isSendable()) {
          await channel.send(payload);
        }
      } catch (error) {
        this.ctx.logger.error({ err: error }, "Failed to post task result");
      }
    }
  }

  /** New files from the agent's outputs directory, as Discord attachments. */
  private async collectFiles(task: Task): Promise<AttachmentBuilder[]> {
    try {
      // Outputs can land a few seconds after the session goes idle.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const files = (await this.agents.listOutputFiles(task.sessionId)).filter(
        (file) => !task.sentFileIds.has(file.id) && file.size <= MAX_ATTACHMENT_BYTES,
      );
      const attachments: AttachmentBuilder[] = [];
      for (const file of files.slice(0, 10)) {
        task.sentFileIds.add(file.id);
        attachments.push(
          new AttachmentBuilder(await this.agents.downloadFile(file.id), {
            name: file.name,
          }),
        );
      }
      return attachments;
    } catch (error) {
      this.ctx.logger.warn({ err: error, sessionId: task.sessionId }, "Failed to collect task files");
      return [];
    }
  }
}

/**
 * Posts the agent's messages to the thread as they come, and batches its
 * tool calls into small-text step lines so they don't flood the thread.
 */
class ProgressFeed {
  private steps: string[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly thread: ThreadChannel) {}

  addStep(step: string) {
    this.steps.push(step);
    this.timer ??= setTimeout(() => void this.flush(), TOOL_FLUSH_MS);
  }

  async post(text: string) {
    for (const chunk of chunkMessage(text)) {
      await this.thread.send(chunk).catch(() => undefined);
    }
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.steps.length === 0) {
      return;
    }
    const lines = this.steps.map((step) => `-# ${step}`);
    this.steps = [];
    await this.post(lines.join("\n"));
  }
}

function describeToolUse(name: string, input: Record<string, unknown>): string {
  const field = (key: string) => {
    const value = input[key];
    return typeof value === "string" ? oneLine(value) : "";
  };
  switch (name) {
    case "bash":
      return `ran \`${field("command").replaceAll("`", "'")}\``;
    case "web_search":
      return `searched "${field("query")}"`;
    case "web_fetch":
      return `read ${field("url")}`;
    case "read":
      return `read ${field("file_path") || field("path")}`;
    case "write":
      return `wrote ${field("file_path") || field("path")}`;
    case "edit":
      return `edited ${field("file_path") || field("path")}`;
    case "glob":
    case "grep":
      return `searched files for ${field("pattern")}`;
    default:
      return `used ${name}`;
  }
}

function oneLine(text: string, max = 120): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
