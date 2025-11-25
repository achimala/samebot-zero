import type { Logger } from "pino";
import { ResultAsync } from "neverthrow";
import type { Memory, MemoryStore } from "./store";
import type { OpenAIClient } from "../openai/client";

const DECAY_RATE = 0.1;
const PURGE_THRESHOLD = 0.05;
const REINFORCEMENT_BOOST = 0.3;
const CONTRADICTION_PENALTY = 0.5;

interface MemoryAnalysis {
  reinforces: string[];
  contradicts: string[];
  isNew: boolean;
}

interface ExtractedFact {
  content: string;
}

function computeEffectiveStrength(memory: Memory): number {
  const now = new Date();
  const daysSinceLastSeen =
    (now.getTime() - memory.lastSeenAt.getTime()) / (1000 * 60 * 60 * 24);
  return memory.strength * Math.exp(-DECAY_RATE * daysSinceLastSeen);
}

export class MemoryService {
  constructor(
    private readonly store: MemoryStore,
    private readonly openai: OpenAIClient,
    private readonly logger: Logger,
  ) {}

  async extractFromBatch(conversationBatch: string): Promise<void> {
    const systemMessage = `You extract factual observations and hypotheses about people from conversations.

Focus on:
- Personal facts (interests, preferences, job, location, relationships)
- Behavioral patterns (how someone typically acts or responds)
- Opinions and beliefs they've expressed
- Relationships between people
- Significant events or experiences mentioned

Format each fact as a standalone statement that would make sense without the original conversation context.
Include the person's name in each fact for clarity.
Only extract meaningful, memorable facts that have long-term relevance - skip trivial statements or ones that only apply to the current conversation.
If nothing memorable is said, return an empty array. Be conservative, it's perfectly OK to return an empty array if there's nothing meaningful.
`;

    const result = await this.openai.chatStructured<{ facts: ExtractedFact[] }>(
      {
        messages: [
          { role: "system", content: systemMessage },
          {
            role: "user",
            content: `Extract facts from this conversation:\n\n${conversationBatch}`,
          },
        ],
        schema: {
          type: "object",
          properties: {
            facts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  content: {
                    type: "string",
                    description: "The factual statement or hypothesis",
                  },
                },
                required: ["content"],
                additionalProperties: false,
              },
            },
          },
          required: ["facts"],
          additionalProperties: false,
        },
        schemaName: "extractedFacts",
        model: "gpt-5-mini",
      },
    );

    if (!result.isOk()) {
      this.logger.error({ err: result.error }, "Failed to extract facts");
      return;
    }

    const facts = result.value.facts;
    if (facts.length === 0) {
      return;
    }

    for (const fact of facts) {
      await this.processObservation(fact.content);
    }

    await this.purgeStaleMemories();
  }

  private async processObservation(observation: string): Promise<void> {
    const embeddingResult = await this.openai.generateEmbedding(observation);

    if (!embeddingResult.isOk()) {
      this.logger.error(
        { err: embeddingResult.error },
        "Failed to generate embedding for observation",
      );
      return;
    }

    const embedding = embeddingResult.value;

    const findResult = await ResultAsync.fromPromise(
      this.store.findSimilar(embedding, 10),
      (error) => error,
    );

    if (findResult.isErr()) {
      this.logger.error(
        { err: findResult.error },
        "Failed to find similar memories",
      );
      return;
    }

    const similarMemories = findResult.value;

    if (similarMemories.length === 0) {
      await this.createMemory(observation, embedding);
      return;
    }

    const analysis = await this.analyzeMemoryRelations(
      observation,
      similarMemories.map((m) => ({ id: m.id, content: m.content })),
    );

    for (const memoryId of analysis.reinforces) {
      await this.reinforceMemory(memoryId);
    }

    for (const memoryId of analysis.contradicts) {
      await this.weakenMemory(memoryId);
    }

    if (analysis.isNew) {
      await this.createMemory(observation, embedding);
    }
  }

  private async analyzeMemoryRelations(
    newObservation: string,
    candidates: Array<{ id: string; content: string }>,
  ): Promise<MemoryAnalysis> {
    const systemMessage = `You are analyzing how a new observation relates to existing memories.

Given a new observation and a list of existing memories, determine:
1. Which existing memories are REINFORCED by this observation (the new info supports or confirms them)
2. Which existing memories are CONTRADICTED by this observation (the new info conflicts with them)
3. Whether this observation contains NEW information not covered by any existing memory

Be conservative - only mark memories as reinforced if the new observation clearly supports them.
Only mark memories as contradicted if there's a genuine conflict.
You can return empty arrays as needed if there's no information to reinforce or contradict any existing memories.
`;

    const candidateList = candidates
      .map((c) => `- [${c.id}]: ${c.content}`)
      .join("\n");

    const userMessage = `New observation: "${newObservation}"

Existing memories:
${candidateList}

Analyze how the new observation relates to these memories.`;

    const result = await this.openai.chatStructured<MemoryAnalysis>({
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage },
      ],
      schema: {
        type: "object",
        properties: {
          reinforces: {
            type: "array",
            items: { type: "string" },
            description: "Array of memory IDs that this observation reinforces",
          },
          contradicts: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of memory IDs that this observation contradicts",
          },
          isNew: {
            type: "boolean",
            description:
              "Whether this contains new information not in existing memories",
          },
        },
        required: ["reinforces", "contradicts", "isNew"],
        additionalProperties: false,
      },
      schemaName: "memoryAnalysis",
      model: "gpt-5-mini",
    });

    if (result.isOk()) {
      return result.value;
    }
    this.logger.error(
      { err: result.error },
      "Failed to analyze memory relations",
    );
    return { reinforces: [], contradicts: [], isNew: true };
  }

  private async createMemory(
    content: string,
    embedding: number[],
  ): Promise<void> {
    const now = new Date();
    await this.store.insert({
      content,
      embedding,
      strength: 1.0,
      lastSeenAt: now,
      createdAt: now,
    });
    this.logger.info({ content }, "Created new memory");
  }

  private async reinforceMemory(memoryId: string): Promise<void> {
    const memories = await this.store.getAll();
    const memory = memories.find((m) => m.id === memoryId);
    if (!memory) {
      return;
    }

    const newStrength = Math.min(memory.strength + REINFORCEMENT_BOOST, 5.0);
    await this.store.update(memoryId, {
      strength: newStrength,
      lastSeenAt: new Date(),
    });
    this.logger.info(
      { memoryId, oldStrength: memory.strength, newStrength },
      "Reinforced memory",
    );
  }

  private async weakenMemory(memoryId: string): Promise<void> {
    const memories = await this.store.getAll();
    const memory = memories.find((m) => m.id === memoryId);
    if (!memory) {
      return;
    }

    const newStrength = memory.strength * (1 - CONTRADICTION_PENALTY);
    await this.store.update(memoryId, { strength: newStrength });
    this.logger.info(
      { memoryId, oldStrength: memory.strength, newStrength },
      "Weakened memory due to contradiction",
    );
  }

  async getRelevantMemories(
    conversationText: string,
    topK: number,
  ): Promise<Memory[]> {
    const embeddingResult =
      await this.openai.generateEmbedding(conversationText);

    if (!embeddingResult.isOk()) {
      this.logger.error(
        { err: embeddingResult.error },
        "Failed to generate embedding for memory retrieval",
      );
      return [];
    }

    const findResult = await ResultAsync.fromPromise(
      this.store.findSimilar(embeddingResult.value, topK * 2),
      (error) => error,
    );

    if (findResult.isErr()) {
      this.logger.error(
        { err: findResult.error },
        "Failed to find similar memories",
      );
      return [];
    }

    const memoriesWithEffectiveStrength = findResult.value.map((memory) => ({
      memory,
      effectiveStrength: computeEffectiveStrength(memory),
    }));

    memoriesWithEffectiveStrength.sort(
      (a, b) => b.effectiveStrength - a.effectiveStrength,
    );

    return memoriesWithEffectiveStrength
      .slice(0, topK)
      .filter((item) => item.effectiveStrength >= PURGE_THRESHOLD)
      .map((item) => item.memory);
  }

  async searchMemories(query: string, topK: number): Promise<Memory[]> {
    const embeddingResult = await this.openai.generateEmbedding(query);

    if (!embeddingResult.isOk()) {
      this.logger.error(
        { err: embeddingResult.error },
        "Failed to generate embedding for memory search",
      );
      return [];
    }

    const findResult = await ResultAsync.fromPromise(
      this.store.findSimilar(embeddingResult.value, topK),
      (error) => error,
    );

    if (findResult.isErr()) {
      this.logger.error(
        { err: findResult.error },
        "Failed to find similar memories",
      );
      return [];
    }

    return findResult.value.filter(
      (memory) => computeEffectiveStrength(memory) >= PURGE_THRESHOLD,
    );
  }

  async purgeStaleMemories(): Promise<number> {
    const allMemories = await this.store.getAll();
    let purgedCount = 0;

    for (const memory of allMemories) {
      const effectiveStrength = computeEffectiveStrength(memory);
      if (effectiveStrength < PURGE_THRESHOLD) {
        await this.store.delete(memory.id);
        this.logger.info(
          { memoryId: memory.id, content: memory.content, effectiveStrength },
          "Purged stale memory",
        );
        purgedCount++;
      }
    }

    return purgedCount;
  }
}
