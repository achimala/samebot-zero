import { DateTime } from "luxon";
import type { Logger } from "pino";
import type { GuildEmoji } from "discord.js";
import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaTextBlockParam } from "@anthropic-ai/sdk/resources/beta";
import {
  type ChatMessage,
  type ClaudeClient,
  type ModelTier,
  WEB_SEARCH_TOOL,
  toMessageParams,
} from "../llm/claude";
import type { GeminiClient } from "../gemini/client";
import type { HonchoMemoryService } from "../memory/service";
import type { ScrapbookService } from "../scrapbook/service";
import type { SupabaseClient } from "../supabase/client";
import type { EntityResolver } from "../utils/entity-resolver";
import type { DiscordAdapter } from "../adapters/discord";
import type { AgentContext, AgentMessage, AgentResponse } from "./types";
import {
  processVideoToGif,
  buildGifPrompt,
} from "../utils/image-processing";
import { fetchImageAsBase64 } from "../utils/fetch-image";
import { DEFAULT_GIF_OPTIONS } from "../utils/emoji-generator";
import {
  GENERATE_IMAGE_TOOL_GUIDANCE,
  IMAGE_ENTITY_CONTEXT,
} from "../utils/image-prompt-instructions";
import { generateScrapbookImagePrompt } from "../utils/scrapbook-image-prompt";

const MAX_TOOL_ITERATIONS = 10;
/** Only the most recent image-bearing messages are shown to the model. */
const MAX_IMAGE_MESSAGES = 4;

export const PERSONA = `you are samebot, a hyper-intelligent, lowercase-talking friend in a discord group chat, with a dry, sarcastic British tone.
you're quintessentially British - British spellings (colour, realise, organise), British expressions ("brilliant", "cheers", "bloody hell", "proper", "bit", "rather"), and British humour (dry wit, understatement, self-deprecation). you rarely use emojis and occasionally swear for comedic effect ("bloody", "bugger", "sodding").

how much to say - match the length to what the message actually needs:
- banter, jokes, greetings and reactions: keep it short and punchy, usually one line. don't over-explain a joke.
- questions, requests for information, advice, explanations or help: actually answer properly. give the useful substance first - facts, specifics, steps, a recommendation - then add wit if it fits. a few sentences or a short list is fine; go longer when someone asks for detail. never swap a real answer for a snide one-liner.
- if you don't know or aren't sure, say so plainly (and search the web when it would help).
- this is chat, not an essay: no headings, no preamble, no restating the question, and keep it under ~1500 characters unless someone explicitly wants more.

the sarcasm is seasoning, not the meal - be genuinely helpful and still sound like yourself.`;

const TOOL_INSTRUCTIONS = `Respond in lowercase only.

You can react to messages, generate images or GIFs, search your memory, search the web, and use the scrapbook of memorable quotes. If the user shares an image you can use it as a reference for generation/modification (reference images are used as references, not pasted into the output).

IMPORTANT: The scrapbook tools (get_scrapbook_memory, search_scrapbook, get_scrapbook_context) post their results directly to the channel. You do NOT need to repeat or summarise what they show.

Your final text response is sent as a message to the channel. An empty response sends nothing - use this when your tool calls already provided the response (e.g. after scrapbook calls). Unless asked to, do not add commentary after the scrapbook tools that auto-post for you.

Each conversation message is prefixed with [time ago] [message id] author. That prefix is internal metadata: use the message IDs when reacting, but never include the prefix in your reply.`;

type ImageAspectRatio =
  | "1:1"
  | "2:3"
  | "3:2"
  | "3:4"
  | "4:3"
  | "9:16"
  | "16:9"
  | "21:9";

export class Agent {
  constructor(
    private readonly llm: ClaudeClient,
    private readonly gemini: GeminiClient,
    private readonly memory: HonchoMemoryService,
    private readonly scrapbook: ScrapbookService,
    private readonly entityResolver: EntityResolver,
    private readonly supabase: SupabaseClient,
    private readonly logger: Logger,
    private readonly customEmoji: Map<string, GuildEmoji>,
    private readonly adapter: DiscordAdapter,
  ) {}

  async generateResponse(
    context: AgentContext,
    triggerMessageId: string,
  ): Promise<AgentResponse> {
    const system = await this.buildSystemPrompt(context);
    const { messages } = toMessageParams(this.buildHistoryMessages(context));

    const result = await this.llm.runAgent({
      system,
      messages,
      tools: [
        ...this.buildTools(context, triggerMessageId),
        WEB_SEARCH_TOOL,
      ],
      // Medium effort: replies range from banter to real answers, and the
      // latter need care. Up-front thinking stays off for latency.
      effort: "medium",
      maxIterations: MAX_TOOL_ITERATIONS,
      maxTokens: 2048,
    });

    return result.match(
      (text) => ({ text }),
      () => ({ text: null }),
    );
  }

  /** A one-to-three word "same"-style agreement, written by the model. */
  async generateBriefReply(context: AgentContext): Promise<AgentResponse> {
    const result = await this.chatWithContext(context, {
      model: "haiku",
      systemMessage: `${PERSONA}\nRespond in lowercase only.`,
      userMessage:
        "Reply to the most recent message with a brief, natural one-to-three word agreement in the spirit of 'same'. Respond with only the reply.",
    });
    return result.match(
      (text) => ({ text: text.toLowerCase() }),
      () => ({ text: null }),
    );
  }

  async generateAutoReact(
    context: AgentContext,
    latestMessageContent: string,
  ): Promise<string[]> {
    const emojiList = this.buildEmojiList();
    const contextText = this.formatContextText(context);

    const response = await this.llm.chatStructured({
      model: "haiku",
      messages: [
        {
          role: "system",
          content: `${PERSONA}
You are picking emoji reactions for a message.

Available custom emoji (including your generated emojis): ${emojiList || "none"}
You can also use any standard Unicode emoji.

Return 1 to 3 emojis that would make good, fun reactions to the most recent message.
For custom emoji, use just the name (e.g. "happy_cat"). For Unicode emoji, use the emoji directly (e.g. "😂").`,
        },
        {
          role: "user",
          content: `Conversation context:\n${contextText}\n\nMost recent message to react to:\n${latestMessageContent}`,
        },
      ],
      schema: z.object({
        emojis: z
          .array(z.string())
          .describe("Emoji names (for custom) or Unicode emoji characters"),
      }),
    });

    return response.match(
      (result) => result.emojis.slice(0, 3),
      (error) => {
        this.logger.warn({ err: error }, "Failed to generate auto-react");
        return [];
      },
    );
  }

  chatWithContext(
    context: AgentContext,
    options: {
      systemMessage: string;
      userMessage: string;
      webSearch?: boolean;
      preserveWhitespace?: boolean;
      model?: ModelTier;
    },
  ) {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: options.systemMessage,
      },
    ];
    if (context.history.length > 0) {
      messages.push({
        role: "user",
        content: `Recent conversation context:\n${this.formatContextText(context)}`,
      });
    }
    messages.push({
      role: "user",
      content: options.userMessage,
    });
    return this.llm.chat({
      messages,
      ...(options.webSearch !== undefined && { webSearch: options.webSearch }),
      ...(options.preserveWhitespace !== undefined && {
        preserveWhitespace: options.preserveWhitespace,
      }),
      ...(options.model !== undefined && { model: options.model }),
    });
  }

  formatContextText(context: AgentContext): string {
    return context.history
      .filter((message) => !isSilentAssistant(message))
      .map((message) => formatHistoryLine(message))
      .join("\n");
  }

  buildEmojiList(): string {
    const emojiList: string[] = [];
    for (const emoji of this.customEmoji.values()) {
      emojiList.push(emoji.name ?? "");
    }
    return emojiList.filter(Boolean).join(", ");
  }

  /**
   * The static part (persona, instructions, emoji and entity lists) comes
   * first and is cached; per-request context (date, memory) follows it.
   */
  private async buildSystemPrompt(
    context: AgentContext,
  ): Promise<BetaTextBlockParam[]> {
    const emojiList = this.buildEmojiList();
    const availableEntities = await this.supabase.listEntityFolders();

    let staticPrompt = `${PERSONA}\n\n${TOOL_INSTRUCTIONS}`;
    if (emojiList.length > 0) {
      staticPrompt += `\n\nAvailable custom emoji (including your generated emojis): ${emojiList}\nYou can use standard Unicode emoji or custom emoji names.`;
    }
    if (availableEntities.length > 0) {
      staticPrompt += `\n\n${IMAGE_ENTITY_CONTEXT.replace("{entities}", availableEntities.join(", "))}`;
    }

    let dynamicPrompt = `Current date: ${DateTime.now().toISO()}`;
    const memoryContext = await this.memory.getPromptContext(context);
    if (memoryContext.length > 0) {
      dynamicPrompt += `\n\nMemory context:\n${memoryContext}`;
    }

    return [
      { type: "text", text: staticPrompt, cache_control: { type: "ephemeral" } },
      { type: "text", text: dynamicPrompt },
    ];
  }

  private buildHistoryMessages(context: AgentContext): ChatMessage[] {
    const imageMessageIds = new Set(
      context.history
        .filter((message) => message.images && message.images.length > 0)
        .slice(-MAX_IMAGE_MESSAGES)
        .map((message) => message.id),
    );

    return context.history
      .filter((message) => !isSilentAssistant(message))
      .map((message) => {
        const chatMessage: ChatMessage = {
          role: message.role,
          content: formatHistoryLine(message),
        };
        if (imageMessageIds.has(message.id) && message.images) {
          chatMessage.images = message.images;
        }
        return chatMessage;
      });
  }

  private buildTools(context: AgentContext, triggerMessageId: string) {
    const channelId = context.channelId;
    const knownMessageIds = new Set(context.history.map((m) => m.id));

    return [
      betaZodTool({
        name: "react",
        description:
          "React to a message with an emoji. Use this to add emoji reactions to messages in the conversation.",
        inputSchema: z.object({
          messageId: z.string().describe("The ID of the message to react to"),
          emoji: z
            .string()
            .describe(
              "The emoji to react with. Can be a Unicode emoji or a custom emoji name.",
            ),
        }),
        run: async ({ messageId, emoji: emojiInput }) => {
          const targetMessageId = knownMessageIds.has(messageId)
            ? messageId
            : triggerMessageId;
          const emoji = this.adapter.resolveEmoji(emojiInput);
          if (!emoji) {
            return `Could not resolve emoji: ${emojiInput}`;
          }
          const result = await this.adapter.react(
            channelId,
            targetMessageId,
            emoji,
          );
          return result.success
            ? `Successfully reacted with ${emojiInput}`
            : `Failed to react with ${emojiInput}`;
        },
      }),
      betaZodTool({
        name: "generate_image",
        description:
          "Generate an image based on a text prompt and post it to the channel. Use this when asked to create, draw, or generate images. Set isGif to true to generate an animated GIF instead of a static image.",
        inputSchema: z.object({
          prompt: z
            .string()
            .describe(
              `A detailed description of the image to generate. ${GENERATE_IMAGE_TOOL_GUIDANCE}`,
            ),
          aspectRatio: z
            .enum(["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"])
            .optional()
            .describe("The aspect ratio for the image (defaults to 1:1)"),
          imageSize: z
            .enum(["1K", "2K", "4K"])
            .optional()
            .describe("The resolution of the image (defaults to 1K)"),
          isGif: z
            .boolean()
            .optional()
            .describe("Generate an animated GIF instead of a static image"),
        }),
        run: (input) => this.generateImage(context, input),
      }),
      betaZodTool({
        name: "search_memory",
        description:
          "Search your memory for information about someone or something. Use this when asked about things you should know but don't have in current context.",
        inputSchema: z.object({
          query: z.string().describe("The search query to find relevant memories"),
        }),
        run: async ({ query }) => {
          const results = await this.memory.searchMemories(query, 10, context);
          if (results.length === 0) {
            return "No relevant memories found for that query.";
          }
          return `Found memories:\n${results.map((r) => `- ${r.content}`).join("\n")}`;
        },
      }),
      betaZodTool({
        name: "get_scrapbook_memory",
        description:
          "Get a random memorable quote from the scrapbook. POSTS DIRECTLY TO CHANNEL - the quote is immediately visible to everyone. Use this when someone asks for a memory, story, or something from the scrapbook.",
        inputSchema: z.object({}),
        run: async () => {
          const memory = await this.scrapbook.getRandomMemory();
          if (!memory) {
            return "No scrapbook memories found.";
          }
          await this.adapter.sendMessage(channelId, formatScrapbookQuote(memory));
          await this.postScrapbookImage(channelId, memory);
          return `Posted scrapbook memory to channel [${memory.id}]: "${memory.keyMessage}" by ${memory.author}`;
        },
      }),
      betaZodTool({
        name: "search_scrapbook",
        description:
          "Search the scrapbook for memorable quotes matching a query. POSTS DIRECTLY TO CHANNEL - results are immediately visible to everyone. Use this when someone asks 'remember when...' or wants to find a specific old quote.",
        inputSchema: z.object({
          query: z
            .string()
            .describe("The search query to find matching scrapbook memories"),
        }),
        run: async ({ query }) => {
          const results = await this.scrapbook.searchMemories(query, 5);
          if (results.length === 0) {
            return "No matching scrapbook memories found.";
          }
          await this.adapter.sendMessage(
            channelId,
            results.map(formatScrapbookQuote).join("\n\n"),
          );
          await Promise.all(
            results.map((memory) => this.postScrapbookImage(channelId, memory)),
          );
          const summary = results
            .map((m) => `[${m.id}]: "${m.keyMessage}" by ${m.author}`)
            .join("; ");
          return `Posted ${results.length} scrapbook memories to channel: ${summary}`;
        },
      }),
      betaZodTool({
        name: "get_scrapbook_context",
        description:
          "Get the surrounding conversation context for a scrapbook memory. POSTS DIRECTLY TO CHANNEL - context is immediately visible to everyone. Use this when someone asks for context, says 'what?', 'huh?', or reacts with confusion to a scrapbook quote.",
        inputSchema: z.object({
          quote: z
            .string()
            .describe("The exact quote text from the scrapbook memory to get context for"),
        }),
        run: async ({ quote }) => {
          const memory = await this.scrapbook.getMemoryByQuote(quote);
          if (!memory) {
            return "Could not find that scrapbook memory.";
          }
          const contextLines = memory.context
            .map((m) => `<${m.author}> ${m.content}`)
            .join("\n");
          const sendResult = await this.adapter.sendMessage(
            channelId,
            `**context for "${memory.keyMessage}":**\n\`\`\`\n${contextLines}\n\`\`\``,
          );
          if (!sendResult.messageId) {
            return "Failed to post context to channel.";
          }
          return `Posted context for "${memory.keyMessage}" to channel`;
        },
      }),
      betaZodTool({
        name: "delete_scrapbook_memory",
        description:
          "Delete a scrapbook memory. Use this when someone says 'bad memory' or asks to remove/forget a scrapbook quote.",
        inputSchema: z.object({
          quote: z
            .string()
            .describe("The exact quote text of the scrapbook memory to delete"),
        }),
        run: async ({ quote }) => {
          const memory = await this.scrapbook.getMemoryByQuote(quote);
          if (!memory) {
            return "Could not find that scrapbook memory.";
          }
          const success = await this.scrapbook.deleteMemory(memory.id);
          return success
            ? "Deleted the scrapbook memory."
            : "Found but could not delete that scrapbook memory.";
        },
      }),
    ];
  }

  private async generateImage(
    context: AgentContext,
    input: {
      prompt: string;
      aspectRatio?: ImageAspectRatio | undefined;
      imageSize?: "1K" | "2K" | "4K" | undefined;
      isGif?: boolean | undefined;
    },
  ): Promise<string> {
    const { prompt } = input;
    const channelId = context.channelId;
    const isGif = input.isGif ?? false;

    let effectivePrompt = prompt;
    const referenceImages = await this.fetchConversationImages(context);

    const resolution = await this.entityResolver.resolve(prompt);
    if (resolution) {
      const built = this.entityResolver.buildPromptWithReferences(resolution);
      effectivePrompt = built.textPrompt;
      if (built.referenceImages) {
        referenceImages.push(...built.referenceImages);
      }
    }

    const placeholder = await this.adapter.sendPlaceholderMessage(
      channelId,
      prompt,
    );
    const fail = async (message: string) => {
      if (placeholder) {
        await this.adapter.editMessage(channelId, placeholder.messageId, message);
      }
      return message;
    };

    if (isGif) {
      const videoResult = await this.gemini.generateVideo({
        prompt: buildGifPrompt(effectivePrompt, false),
        ...(referenceImages.length > 0 && { referenceImages }),
      });
      if (videoResult.isErr()) {
        this.logger.error({ err: videoResult.error }, "GIF video generation failed");
        return fail(`failed to generate GIF: ${videoResult.error.message}`);
      }
      let gif: Buffer;
      try {
        gif = await processVideoToGif(
          videoResult.value.buffer,
          DEFAULT_GIF_OPTIONS,
          512,
        );
      } catch (error) {
        this.logger.error({ err: error }, "Failed to process GIF");
        return fail(
          `failed to process GIF: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
      return this.deliverImage(channelId, placeholder, gif, "samebot-image.gif", prompt);
    }

    const imageResult = await this.gemini.generateImage({
      prompt: effectivePrompt,
      ...(referenceImages.length > 0 && { referenceImages }),
      ...(input.aspectRatio !== undefined && { aspectRatio: input.aspectRatio }),
      ...(input.imageSize !== undefined && { imageSize: input.imageSize }),
    });
    if (imageResult.isErr()) {
      this.logger.error({ err: imageResult.error }, "Image generation failed");
      return fail(`failed to generate image: ${imageResult.error.message}`);
    }
    return this.deliverImage(
      channelId,
      placeholder,
      imageResult.value.buffer,
      "samebot-image.png",
      prompt,
    );
  }

  private async deliverImage(
    channelId: string,
    placeholder: { messageId: string } | null,
    buffer: Buffer,
    fileName: string,
    prompt: string,
  ): Promise<string> {
    const result = placeholder
      ? await this.adapter.editMessageWithImage(
          channelId,
          placeholder.messageId,
          buffer,
          fileName,
          prompt,
        )
      : await this.adapter.sendImage(channelId, buffer, fileName, prompt);
    if (!result.success) {
      this.logger.error({ prompt }, "Failed to post generated image");
      return `Generated image but failed to send: ${result.error}`;
    }
    return `Successfully generated and posted image for: ${prompt}`;
  }

  private async postScrapbookImage(
    channelId: string,
    memory: {
      id: string;
      keyMessage: string;
      author: string;
      context: Array<{ author: string; content: string }>;
    },
  ) {
    const imagePrompt = await generateScrapbookImagePrompt(
      this.llm,
      this.entityResolver,
      memory,
      this.logger,
    );
    if (!imagePrompt) {
      return;
    }
    const imageResult = await this.gemini.generateImage({
      prompt: imagePrompt.textPrompt,
      aspectRatio: "16:9",
      ...(imagePrompt.referenceImages && {
        referenceImages: imagePrompt.referenceImages,
      }),
    });
    if (imageResult.isErr()) {
      this.logger.warn(
        { err: imageResult.error, memoryId: memory.id },
        "Failed to generate scrapbook image",
      );
      return;
    }
    await this.adapter.sendImage(
      channelId,
      imageResult.value.buffer,
      "scrapbook-memory.png",
      imagePrompt.textPrompt,
    );
  }

  /** Downloads recent conversation images to use as generation references. */
  private async fetchConversationImages(
    context: AgentContext,
  ): Promise<Array<{ data: string; mimeType: string }>> {
    const urls = context.history
      .filter((message) => message.images && message.images.length > 0)
      .slice(-MAX_IMAGE_MESSAGES)
      .flatMap((message) => message.images ?? []);
    const images = await Promise.all(
      urls.map((url) => fetchImageAsBase64(url, this.logger)),
    );
    return images.filter((image) => image !== null);
  }
}

function isSilentAssistant(message: AgentMessage) {
  return message.role === "assistant" && message.content === "(silent)";
}

function formatHistoryLine(message: AgentMessage): string {
  const seconds = Math.round((Date.now() - message.timestamp) / 1000);
  const timeAgo =
    seconds < 60
      ? `${seconds}s ago`
      : seconds < 3600
        ? `${Math.round(seconds / 60)}m ago`
        : `${Math.round(seconds / 3600)}h ago`;
  const author =
    message.role === "assistant" ? "samebot" : (message.author ?? "user");
  return `[${timeAgo}] [${message.id}] ${author}: ${message.content}`;
}

function formatScrapbookQuote(memory: { keyMessage: string; author: string }) {
  return `> ${memory.keyMessage}\n— ${memory.author}`;
}
