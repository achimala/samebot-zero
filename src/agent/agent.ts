import { DateTime } from "luxon";
import type { Logger } from "pino";
import type { GuildEmoji } from "discord.js";
import type {
  ToolDefinition,
  ToolCall,
  ChatMessage,
  ToolMessage,
  OpenAIClient,
} from "../openai/client";
import type { MemoryService } from "../memory/service";
import type { ScrapbookService } from "../scrapbook/service";
import type { SupabaseClient } from "../supabase/client";
import type { EntityResolver } from "../utils/entity-resolver";
import type { DiscordAdapter } from "../adapters/discord";
import type { AgentContext, AgentResponse } from "./types";
import {
  processGifEmojiGrid,
  buildGifPrompt,
} from "../utils/image-processing";
import { DEFAULT_GIF_OPTIONS } from "../utils/emoji-generator";

const MAX_TOOL_ITERATIONS = 10;

const PERSONA = `you are samebot, a hyper-intelligent, lowercase-talking friend with a dry, sarcastic British tone.
you're quintessentially British - use British spellings (colour, realise, organise, etc.), British expressions ("brilliant", "cheers", "bloody hell", "right", "proper", "bit", "quite", "rather"), and British humour (dry wit, understatement, self-deprecation).
you keep responses extremely short, rarely use emojis, and occasionally swear for comedic effect (British swearing like "bloody", "bugger", "sodding").
always respond very briefly - aim for 5-10 words maximum. be terse and to the point. only expand if explicitly asked for detail.
speak like a proper Brit - understated, witty, and occasionally self-deprecating.`;

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "react",
    description:
      "React to a message with an emoji. Use this to add emoji reactions to messages in the conversation.",
    parameters: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description: "The ID of the message to react to",
        },
        emoji: {
          type: "string",
          description:
            "The emoji to react with. Can be a Unicode emoji or a custom emoji name.",
        },
      },
      required: ["messageId", "emoji"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_image",
    description:
      "Generate an image based on a text prompt. Use this when asked to create, draw, or generate images. Set isGif to true to generate an animated GIF instead of a static image.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "A detailed description of the image to generate",
        },
        aspectRatio: {
          type: ["string", "null"],
          enum: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"],
          description: "The aspect ratio for the image (defaults to 1:1)",
        },
        imageSize: {
          type: ["string", "null"],
          enum: ["1K", "2K", "4K"],
          description: "The resolution of the image (defaults to 1K)",
        },
        isGif: {
          type: "boolean",
          description: "Whether to generate an animated GIF instead of a static image (defaults to false)",
        },
      },
      required: ["prompt", "aspectRatio", "imageSize", "isGif"],
      additionalProperties: false,
    },
  },
  {
    name: "search_memory",
    description:
      "Search your memory for information about someone or something. Use this when asked about things you should know but don't have in current context.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to find relevant memories",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_scrapbook_memory",
    description:
      "Get a random memorable quote from the scrapbook. POSTS DIRECTLY TO CHANNEL - the quote is immediately visible to everyone. Use this when someone asks for a memory, story, or something from the scrapbook.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "search_scrapbook",
    description:
      "Search the scrapbook for memorable quotes matching a query. POSTS DIRECTLY TO CHANNEL - results are immediately visible to everyone. Use this when someone asks 'remember when...' or wants to find a specific old quote.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to find matching scrapbook memories",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_scrapbook_context",
    description:
      "Get the surrounding conversation context for a scrapbook memory. POSTS DIRECTLY TO CHANNEL - context is immediately visible to everyone. Use this when someone asks for context, says 'what?', 'huh?', or reacts with confusion to a scrapbook quote.",
    parameters: {
      type: "object",
      properties: {
        quote: {
          type: "string",
          description:
            "The exact quote text from the scrapbook memory to get context for",
        },
      },
      required: ["quote"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_scrapbook_memory",
    description:
      "Delete a scrapbook memory. Use this when someone says 'bad memory' or asks to remove/forget a scrapbook quote.",
    parameters: {
      type: "object",
      properties: {
        quote: {
          type: "string",
          description: "The exact quote text of the scrapbook memory to delete",
        },
      },
      required: ["quote"],
      additionalProperties: false,
    },
  },
];

interface MessageReference {
  id: string;
  role: "user" | "assistant";
  content: string;
  author?: string;
}

interface ToolExecutionContext {
  channelId: string;
  triggerMessageId: string;
  messageIdMap: Map<string, string>;
  agentContext: AgentContext;
}

export class Agent {
  constructor(
    private readonly openai: OpenAIClient,
    private readonly memory: MemoryService,
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
    const modelContext = await this.buildModelContext(context);

    const messageIdMap = new Map<string, string>();
    for (const ref of modelContext.contextWithIds.references) {
      messageIdMap.set(ref.id, ref.id);
    }
    messageIdMap.set(triggerMessageId, triggerMessageId);

    const executionContext: ToolExecutionContext = {
      channelId: context.channelId,
      triggerMessageId,
      messageIdMap,
      agentContext: context,
    };

    const messages: Array<ChatMessage | ToolMessage> = [
      ...modelContext.messages,
    ];

    const toolCallsMade: ToolCall[] = [];
    let finalResponse: string | null = null;
    let previousResponseId: string | undefined;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const toolStepOptions: {
        messages: Array<ChatMessage | ToolMessage>;
        tools: ToolDefinition[];
        allowSearch: boolean;
        previousResponseId?: string;
      } = {
        messages,
        tools: TOOL_DEFINITIONS,
        allowSearch: true,
      };
      if (previousResponseId !== undefined) {
        toolStepOptions.previousResponseId = previousResponseId;
      }
      const result = await this.openai.chatWithToolsStep(toolStepOptions);

      const stepResult = result.match(
        (value) => value,
        (error) => {
          this.logger.error({ err: error }, "Failed to get tool step response");
          return null;
        },
      );

      if (!stepResult) {
        return { text: "something broke, back in a bit", toolCallsMade };
      }

      if (stepResult.done) {
        finalResponse = stepResult.text;
        break;
      }

      previousResponseId = stepResult.responseId;

      this.logger.info(
        { toolCalls: stepResult.toolCalls, iteration },
        "Executing tool calls",
      );

      for (const toolCall of stepResult.toolCalls) {
        toolCallsMade.push(toolCall);
        const toolResult = await this.executeToolCall(
          toolCall,
          executionContext,
        );
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: toolResult,
        });
      }
    }

    return { text: finalResponse, toolCallsMade };
  }

  async generateAutoReact(
    context: AgentContext,
    latestMessageContent: string,
  ): Promise<string[]> {
    const emojiList = this.buildEmojiList();
    const contextText = this.formatContextText(context);

    const systemMessage = `${PERSONA}
You are deciding whether to react to a message with emoji(s).

Available custom emoji (including your generated emojis): ${emojiList || "none"}
You can also use any standard Unicode emoji.

Based on the conversation context and the most recent message, decide if any emoji reactions would be appropriate and fun.
Return 0 to 3 emojis that would make good reactions. Return an empty array if no reaction feels right.
For custom emoji, use just the name (e.g. "happy_cat"). For Unicode emoji, use the emoji directly (e.g. "😂").`;

    const response = await this.openai.chatStructured<{ emojis: string[] }>({
      messages: [
        {
          role: "system",
          content: systemMessage,
        },
        {
          role: "user",
          content: `Conversation context:\n${contextText}\n\nMost recent message to potentially react to:\n${latestMessageContent}`,
        },
      ],
      schema: {
        type: "object",
        properties: {
          emojis: {
            type: "array",
            items: {
              type: "string",
              description: "Emoji name (for custom) or Unicode emoji character",
            },
            description: "Array of 0-3 emojis to react with",
          },
        },
        required: ["emojis"],
        additionalProperties: false,
      },
      schemaName: "autoReact",
      schemaDescription: "Emoji reactions to add to message",
    });

    return response.match(
      (result) => result.emojis.slice(0, 3),
      (error) => {
        this.logger.warn({ err: error }, "Failed to generate auto-react");
        return [];
      },
    );
  }

  async shouldSaySame(
    context: AgentContext,
    latestMessageContent: string,
  ): Promise<{ shouldSaySame: boolean; response?: string }> {
    const contextText = this.formatContextText(context);

    const systemMessage = `${PERSONA}
You are deciding whether saying "same" or a similar brief agreement would be contextually appropriate and natural.

Say "same" (or similar) when:
- Someone expresses a relatable feeling, experience, or opinion
- Someone shares something you can relate to
- The conversation is casual and friendly
- It would be a natural, brief response

Do NOT say "same" when:
- Someone is asking a question that needs an answer
- The message requires a substantive response
- It would be awkward or inappropriate
- You've already said "same" recently in the conversation

If appropriate, provide a brief response (1-3 words max). Examples: "same", "same here", "yeah same", "literally same", "mood", "big mood", "felt", "relatable", etc. Keep it brief and natural. Use lowercase.`;

    const response = await this.openai.chatStructured<{
      shouldSaySame: boolean;
      response?: string;
    }>({
      messages: [
        {
          role: "system",
          content: systemMessage,
        },
        {
          role: "user",
          content: `Conversation context:\n${contextText}\n\nMost recent message:\n${latestMessageContent}\n\nWould saying "same" or similar be contextually appropriate here? If yes, what should the response be?`,
        },
      ],
      schema: {
        type: "object",
        properties: {
          shouldSaySame: {
            type: "boolean",
            description:
              "Whether saying 'same' or similar would be contextually appropriate",
          },
          response: {
            type: "string",
            description:
              "The brief response to use if shouldSaySame is true (1-3 words max, lowercase)",
          },
        },
        required: ["shouldSaySame", "response"],
        additionalProperties: false,
      },
      schemaName: "shouldSaySame",
      schemaDescription: "Decision on whether to say 'same' and what response to use",
    });

    return response.match(
      (result) => {
        if (result.shouldSaySame && result.response) {
          return {
            shouldSaySame: true,
            response: result.response.trim().toLowerCase(),
          };
        }
        return { shouldSaySame: false };
      },
      (error) => {
        this.logger.warn({ err: error }, "Failed to check if should say same");
        return { shouldSaySame: false };
      },
    );
  }

  chatWithContext(
    context: AgentContext,
    options: {
      systemMessage: string;
      userMessage: string;
      allowSearch?: boolean;
    },
  ) {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: options.systemMessage,
      },
    ];
    if (context.history.length > 0) {
      const contextText = this.formatContextText(context);
      messages.push({
        role: "user",
        content: `Recent conversation context:\n${contextText}`,
      });
    }
    messages.push({
      role: "user",
      content: options.userMessage,
    });
    const chatOptions: { messages: ChatMessage[]; allowSearch?: boolean } = {
      messages,
    };
    if (options.allowSearch !== undefined) {
      chatOptions.allowSearch = options.allowSearch;
    }
    return this.openai.chat(chatOptions);
  }

  formatContextWithIds(context: AgentContext): {
    text: string;
    references: MessageReference[];
  } {
    const now = Date.now();
    const lines: string[] = [];
    const references: MessageReference[] = [];

    for (const message of context.history) {
      const messageId = message.id;
      const timeAgo = Math.round((now - message.timestamp) / 1000);
      const timeAgoText =
        timeAgo < 60
          ? `${timeAgo}s ago`
          : timeAgo < 3600
            ? `${Math.round(timeAgo / 60)}m ago`
            : `${Math.round(timeAgo / 3600)}h ago`;

      const fullContent = message.author
        ? `${message.author}: ${message.content}`
        : message.content;

      lines.push(
        `[${timeAgoText}] [${messageId}] ${message.role}: ${fullContent}`,
      );
      if (message.role !== "assistant" || message.content !== "(silent)") {
        const reference: MessageReference = {
          id: messageId,
          role: message.role,
          content: message.content,
        };
        if (message.author !== undefined) {
          reference.author = message.author;
        }
        references.push(reference);
      }
    }

    return {
      text: lines.join("\n"),
      references,
    };
  }

  formatContextText(context: AgentContext): string {
    const { text } = this.formatContextWithIds(context);
    return text;
  }

  buildEmojiList(): string {
    const emojiList: string[] = [];
    for (const emoji of this.customEmoji.values()) {
      const format = emoji.animated
        ? `<a:${emoji.name}:${emoji.id}>`
        : `<:${emoji.name}:${emoji.id}>`;
      emojiList.push(`${emoji.name} (${format})`);
    }
    return emojiList.join(", ");
  }

  private async buildModelContext(context: AgentContext): Promise<{
    messages: ChatMessage[];
    contextWithIds: { text: string; references: MessageReference[] };
  }> {
    const contextWithIds = this.formatContextWithIds(context);
    const emojiList = this.buildEmojiList();
    const emojiContext =
      emojiList.length > 0
        ? `\n\nAvailable custom emoji (including your generated emojis): ${emojiList}\nYou can use either standard Unicode emoji or custom emoji names/format.`
        : "";

    const availableEntities = await this.supabase.listEntityFolders();
    const entityContext =
      availableEntities.length > 0
        ? `\n\nWhen generating images, you can feature these people/entities (we have reference images for them): ${availableEntities.join(", ")}. Include them by name in your image prompt to use their likeness. Note: These reference images are used as references for generation, not as images to be directly pasted into the output.`
        : "";

    const relevantMemories = await this.memory.getRelevantMemories(
      contextWithIds.text,
      10,
    );
    const memoryContext =
      relevantMemories.length > 0
        ? `\n\nThings you remember about the people in this conversation:\n${relevantMemories.map((m) => `- ${m.content}`).join("\n")}`
        : "";

    const systemMessage = `${PERSONA}\nCurrent date: ${DateTime.now().toISO()}\nRespond in lowercase only.

You have tools available to:
- react: React to a message with an emoji
- generate_image: Generate an image with a prompt (if the user shares an image, you can use it as a reference for generation/modification - note that reference images are used as references, not as images to be directly pasted into the output)
- search_memory: Search your memory for information you don't currently recall
- get_scrapbook_memory: Get a random memorable quote from the scrapbook (POSTS TO CHANNEL)
- search_scrapbook: Search for specific memorable quotes (POSTS TO CHANNEL)
- get_scrapbook_context: Get the surrounding conversation for a scrapbook memory (POSTS TO CHANNEL)
- delete_scrapbook_memory: Delete a scrapbook memory (use when someone says "bad memory")

IMPORTANT: The scrapbook tools (get_scrapbook_memory, search_scrapbook, get_scrapbook_context) automatically post their results directly to the channel. You do NOT need to repeat or summarize what they show.

Your final text response will be sent as a message to the channel. An empty response sends nothing - use this when your tool calls have already provided the response (like after scrapbook calls). Unless asked to do so, do not add additional commentary after calling the scrapbook tools that auto-post for you, just provide an empty response after those.

Message references in context (use these IDs when reacting):
${contextWithIds.references.map((ref) => `- ${ref.id}: ${ref.role}${ref.author ? ` (${ref.author})` : ""}: ${ref.content}`).join("\n")}${emojiContext}${entityContext}${memoryContext}`;

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: systemMessage,
      },
    ];

    for (const message of context.history) {
      const now = Date.now();
      const timeAgo = Math.round((now - message.timestamp) / 1000);
      const timeAgoText =
        timeAgo < 60
          ? `${timeAgo}s ago`
          : timeAgo < 3600
            ? `${Math.round(timeAgo / 60)}m ago`
            : `${Math.round(timeAgo / 3600)}h ago`;

      const prefix = message.author ? `${message.author}: ` : "";
      const contentWithMeta = `[${timeAgoText}] [${message.id}] ${prefix}${message.content}`;

      const chatMessage: ChatMessage = {
        role: message.role === "assistant" ? "assistant" : "user",
        content: contentWithMeta,
      };

      if (
        message.role === "user" &&
        message.images &&
        message.images.length > 0
      ) {
        chatMessage.images = message.images;
      }

      messages.push(chatMessage);
    }

    return {
      messages,
      contextWithIds,
    };
  }

  private async executeToolCall(
    toolCall: ToolCall,
    executionContext: ToolExecutionContext,
  ): Promise<string> {
    const { channelId, triggerMessageId, agentContext } = executionContext;

    switch (toolCall.name) {
      case "react": {
        const messageId = toolCall.arguments.messageId as string;
        const emojiInput = toolCall.arguments.emoji as string;
        const targetMessageId =
          executionContext.messageIdMap.get(messageId) || triggerMessageId;
        const emoji = this.adapter.resolveEmoji(emojiInput);
        if (emoji) {
          const result = await this.adapter.react(
            channelId,
            targetMessageId,
            emoji,
          );
          if (result.success) {
            return `Successfully reacted with ${emojiInput}`;
          }
          return `Failed to react with ${emojiInput}`;
        }
        return `Could not resolve emoji: ${emojiInput}`;
      }

      case "generate_image": {
        const prompt = toolCall.arguments.prompt as string;
        const aspectRatio = toolCall.arguments.aspectRatio as
          | "1:1"
          | "2:3"
          | "3:2"
          | "3:4"
          | "4:3"
          | "9:16"
          | "16:9"
          | "21:9"
          | undefined;
        const imageSize = toolCall.arguments.imageSize as
          | "1K"
          | "2K"
          | "4K"
          | undefined;
        const isGif = (toolCall.arguments.isGif as boolean | undefined) ?? false;

        let effectivePrompt = prompt;
        const referenceImages: Array<{ data: string; mimeType: string }> = [];

        const conversationImages = this.extractConversationImages(agentContext);
        referenceImages.push(...conversationImages);

        const resolution = await this.entityResolver.resolve(prompt);
        if (resolution) {
          const built =
            this.entityResolver.buildPromptWithReferences(resolution);
          effectivePrompt = built.textPrompt;
          if (built.referenceImages) {
            referenceImages.push(...built.referenceImages);
          }
        }

        if (isGif) {
          const gridSize = Math.sqrt(DEFAULT_GIF_OPTIONS.frames);
          effectivePrompt = buildGifPrompt(effectivePrompt, gridSize, false);
        }

        const placeholderMessage = await this.adapter.sendPlaceholderMessage(
          channelId,
          prompt,
        );

        const imageOptions: {
          prompt: string;
          referenceImages?: Array<{ data: string; mimeType: string }>;
          aspectRatio?:
            | "1:1"
            | "2:3"
            | "3:2"
            | "3:4"
            | "4:3"
            | "9:16"
            | "16:9"
            | "21:9";
          imageSize?: "1K" | "2K" | "4K";
        } = {
          prompt: effectivePrompt,
        };
        if (referenceImages.length > 0) {
          imageOptions.referenceImages = referenceImages;
        }
        if (aspectRatio !== undefined) {
          imageOptions.aspectRatio = aspectRatio;
        }
        if (imageSize !== undefined) {
          imageOptions.imageSize = imageSize;
        }
        const imageResult = await this.openai.generateImage(imageOptions);

        let resultMessage = "";
        await imageResult.match(
          async ({ buffer }) => {
            let finalBuffer = buffer;
            const fileExtension = isGif ? "gif" : "png";
            const fileName = `samebot-image.${fileExtension}`;

            if (isGif) {
              try {
                finalBuffer = await processGifEmojiGrid(buffer, DEFAULT_GIF_OPTIONS);
              } catch (error) {
                this.logger.error({ err: error }, "Failed to process GIF");
                if (placeholderMessage) {
                  await this.adapter.editMessage(
                    channelId,
                    placeholderMessage.messageId,
                    `failed to process GIF: ${error instanceof Error ? error.message : "unknown error"}`,
                  );
                }
                resultMessage = `Failed to process GIF: ${error instanceof Error ? error.message : "unknown error"}`;
                return;
              }
            }

            if (placeholderMessage) {
              const editResult = await this.adapter.editMessageWithImage(
                channelId,
                placeholderMessage.messageId,
                finalBuffer,
                fileName,
                prompt,
              );
              if (editResult.success) {
                resultMessage = `Successfully generated and sent ${isGif ? "GIF" : "image"} for: ${prompt}`;
              } else {
                this.logger.error(
                  { err: editResult.error },
                  "Failed to edit message with image",
                );
                const sendResult = await this.adapter.sendImage(
                  channelId,
                  finalBuffer,
                  fileName,
                  prompt,
                );
                if (sendResult.success) {
                  resultMessage = `Successfully generated and sent ${isGif ? "GIF" : "image"} for: ${prompt}`;
                } else {
                  resultMessage = `Generated ${isGif ? "GIF" : "image"} but failed to send it`;
                }
              }
            } else {
              const sendResult = await this.adapter.sendImage(
                channelId,
                finalBuffer,
                fileName,
                prompt,
              );
              if (sendResult.success) {
                resultMessage = `Successfully generated and sent ${isGif ? "GIF" : "image"} for: ${prompt}`;
              } else {
                this.logger.error(
                  { err: sendResult.error },
                  "Failed to send image",
                );
                resultMessage = `Generated ${isGif ? "GIF" : "image"} but failed to send it`;
              }
            }
          },
          async (error) => {
            this.logger.error({ err: error }, "Image generation failed");
            if (placeholderMessage) {
              await this.adapter.editMessage(
                channelId,
                placeholderMessage.messageId,
                `failed to generate image: ${error.message}`,
              );
            }
            resultMessage = `Failed to generate image: ${error.message}`;
          },
        );
        return resultMessage;
      }

      case "search_memory": {
        const query = toolCall.arguments.query as string;
        const searchResults = await this.memory.searchMemories(query, 10);
        if (searchResults.length > 0) {
          const memoryResultsText = searchResults
            .map((m) => `- ${m.content}`)
            .join("\n");
          return `Found memories:\n${memoryResultsText}`;
        }
        return "No relevant memories found for that query.";
      }

      case "get_scrapbook_memory": {
        const memory = await this.scrapbook.getRandomMemory();
        if (memory) {
          const formatted = this.formatScrapbookMemory(memory);
          await this.adapter.sendMessage(channelId, formatted);

          const imagePromptResult = await this.generateImageForScrapbookMemory(memory);
          if (imagePromptResult) {
            const imageOptions: Parameters<typeof this.openai.generateImage>[0] = {
              prompt: imagePromptResult.textPrompt,
              aspectRatio: "16:9",
            };
            if (imagePromptResult.referenceImages) {
              imageOptions.referenceImages = imagePromptResult.referenceImages;
            }
            const imageResult = await this.openai.generateImage(imageOptions);

            await imageResult.match(
              async ({ buffer }) => {
                await this.adapter.sendImage(
                  channelId,
                  buffer,
                  "scrapbook-memory.png",
                  imagePromptResult.textPrompt,
                );
              },
              async (error) => {
                this.logger.warn(
                  { err: error },
                  "Failed to generate scrapbook image",
                );
              },
            );
          }

          return `Posted scrapbook memory to channel [${memory.id}]: "${memory.keyMessage}" by ${memory.author}`;
        }
        return "No scrapbook memories found.";
      }

      case "search_scrapbook": {
        const query = toolCall.arguments.query as string;
        const results = await this.scrapbook.searchMemories(query, 5);
        if (results.length > 0) {
          const formatted = this.formatScrapbookSearchResults(results);
          await this.adapter.sendMessage(channelId, formatted);

          for (const memory of results) {
            const imagePromptResult = await this.generateImageForScrapbookMemory(memory);
            if (imagePromptResult) {
              const imageOptions: Parameters<typeof this.openai.generateImage>[0] = {
                prompt: imagePromptResult.textPrompt,
                aspectRatio: "16:9",
              };
              if (imagePromptResult.referenceImages) {
                imageOptions.referenceImages = imagePromptResult.referenceImages;
              }
              const imageResult = await this.openai.generateImage(imageOptions);

              await imageResult.match(
                async ({ buffer }) => {
                  await this.adapter.sendImage(
                    channelId,
                    buffer,
                    "scrapbook-memory.png",
                    imagePromptResult.textPrompt,
                  );
                },
                async (error) => {
                  this.logger.warn(
                    { err: error, memoryId: memory.id },
                    "Failed to generate scrapbook image for search result",
                  );
                },
              );
            }
          }

          const summaryText = results
            .map((m) => `[${m.id}]: "${m.keyMessage}" by ${m.author}`)
            .join("; ");
          return `Posted ${results.length} scrapbook memories to channel: ${summaryText}`;
        }
        return "No matching scrapbook memories found.";
      }

      case "get_scrapbook_context": {
        const quote = toolCall.arguments.quote as string;
        const memory = await this.scrapbook.getMemoryByQuote(quote);
        if (memory) {
          const formatted = this.formatScrapbookContext(memory);
          const sendResult = await this.adapter.sendMessage(
            channelId,
            formatted,
          );
          if (!sendResult.messageId) {
            this.logger.error({}, "Failed to post scrapbook context");
            return "Failed to post context to channel.";
          }
          return `Posted context for "${memory.keyMessage}" to channel`;
        }
        return "Could not find that scrapbook memory.";
      }

      case "delete_scrapbook_memory": {
        const quote = toolCall.arguments.quote as string;
        const memory = await this.scrapbook.getMemoryByQuote(quote);
        if (memory) {
          const success = await this.scrapbook.deleteMemory(memory.id);
          if (success) {
            return "Deleted the scrapbook memory.";
          }
          return "Found but could not delete that scrapbook memory.";
        }
        return "Could not find that scrapbook memory.";
      }

      default:
        return `Unknown tool: ${toolCall.name}`;
    }
  }

  private extractConversationImages(
    context: AgentContext,
  ): Array<{ data: string; mimeType: string }> {
    const images: Array<{ data: string; mimeType: string }> = [];

    for (const message of context.history) {
      if (message.images && message.images.length > 0) {
        for (const dataUri of message.images) {
          const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
          if (match && match[1] && match[2]) {
            images.push({
              mimeType: match[1],
              data: match[2],
            });
          }
        }
      }
    }

    return images;
  }

  private formatScrapbookMemory(memory: {
    id: string;
    keyMessage: string;
    author: string;
  }): string {
    return `> ${memory.keyMessage}\n— ${memory.author}`;
  }

  private formatScrapbookSearchResults(
    results: Array<{ id: string; keyMessage: string; author: string }>,
  ): string {
    return results
      .map((memory) => `> ${memory.keyMessage}\n— ${memory.author}`)
      .join("\n\n");
  }

  private formatScrapbookContext(memory: {
    keyMessage: string;
    context: Array<{ author: string; content: string }>;
  }): string {
    const contextLines = memory.context
      .map((m) => `<${m.author}> ${m.content}`)
      .join("\n");
    return `**context for "${memory.keyMessage}":**\n\`\`\`\n${contextLines}\n\`\`\``;
  }

  private async generateImageForScrapbookMemory(
    memory: {
      keyMessage: string;
      author: string;
      context: Array<{ author: string; content: string }>;
    },
  ): Promise<{
    textPrompt: string;
    referenceImages?: Array<{ data: string; mimeType: string }>;
  } | null> {
    const contextText = memory.context
      .map((m) => `<${m.author}> ${m.content}`)
      .join("\n");

    const authors = new Set<string>();
    authors.add(memory.author);
    for (const m of memory.context) {
      authors.add(m.author);
    }
    const authorText = Array.from(authors).join(" ");

    const entityResolution = await this.entityResolver.resolve(authorText);
    let basePrompt = `Create an image prompt based on this conversation. Use the full conversation context to capture the scene:\n\nConversation context:\n${contextText}\n\nKey quote: "${memory.keyMessage}" - ${memory.author}`;
    let referenceImages: Array<{ data: string; mimeType: string }> | undefined;

    if (entityResolution) {
      const built = this.entityResolver.buildPromptWithReferences(entityResolution);
      basePrompt = `${built.textPrompt}\n\n${basePrompt}`;
      referenceImages = built.referenceImages;
    }

    const result = await this.openai.chatStructured<{ prompt: string }>({
      messages: [
        {
          role: "system",
          content: `You create artistic image prompts based on chat conversations.
Given a chat quote and its full conversation context, create a creative, whimsical image prompt that captures the scene and essence of the moment.
The image should be surreal, artistic, and evocative - not a literal depiction.
Use the entire conversation context to understand the scene, mood, and setting of the moment.
Keep the prompt concise (under 100 words).
Note: Any reference images provided are used as references for generation, not as images to be directly pasted into the output.`,
        },
        {
          role: "user",
          content: basePrompt,
        },
      ],
      schema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The image generation prompt",
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      schemaName: "imagePrompt",
      model: "gpt-5-mini",
    });

    if (result.isOk()) {
      return {
        textPrompt: result.value.prompt,
        referenceImages,
      };
    }

    this.logger.warn(
      { err: result.error },
      "Failed to generate image prompt for scrapbook memory",
    );
    return null;
  }
}
