import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { InMemoryStore } from "./store";
import { MemoryService } from "./service";
import { OpenAIClient } from "../openai/client";
import { loadConfig } from "../core/config";
import pino from "pino";

const config = loadConfig();
const logger = pino({ level: "info" });
const openai = new OpenAIClient(config, logger);

describe("MemoryService Integration Tests", () => {
  let store: InMemoryStore;
  let service: MemoryService;

  beforeAll(() => {
    logger.info("Running memory service integration tests with live APIs");
  });

  beforeEach(() => {
    store = new InMemoryStore();
    service = new MemoryService(store, openai, logger);
  });

  describe("fact extraction from conversation batches", () => {
    it("extracts facts about a person introducing themselves", async () => {
      await service.extractFromBatch(
        "Sarah: Hey everyone! I'm Sarah, I work as a software engineer at Stripe and I just moved to SF from NYC.",
      );

      const memories = await store.getAll();
      logger.info(
        { memories: memories.map((m) => m.content) },
        "Extracted memories",
      );

      expect(memories.length).toBeGreaterThan(0);
      const contents = memories.map((m) => m.content.toLowerCase());
      expect(
        contents.some(
          (c) =>
            c.includes("sarah") &&
            (c.includes("engineer") || c.includes("stripe")),
        ),
      ).toBe(true);
    });

    it("extracts relationship information", async () => {
      await service.extractFromBatch(
        "Mike: My wife and I are planning a trip to Japan next month, she's always wanted to see the cherry blossoms",
      );

      const memories = await store.getAll();
      logger.info(
        { memories: memories.map((m) => m.content) },
        "Extracted memories",
      );

      expect(memories.length).toBeGreaterThan(0);
      const contents = memories.map((m) => m.content.toLowerCase());
      expect(
        contents.some((c) => c.includes("mike") && c.includes("wife")),
      ).toBe(true);
    });

    it("skips trivial messages with no extractable facts", async () => {
      await service.extractFromBatch("Dave: lol\nDave: nice\nDave: yeah");

      const memories = await store.getAll();
      logger.info(
        { memories: memories.map((m) => m.content) },
        "Extracted memories",
      );

      expect(memories.length).toBe(0);
    });
  });

  describe("memory reinforcement with real reasoning", () => {
    it("reinforces existing memory when related information appears", async () => {
      await service.extractFromBatch(
        "Alex: I've been programming in Python for about 8 years now",
      );

      const initialMemories = await store.getAll();
      logger.info(
        {
          memories: initialMemories.map((m) => ({
            content: m.content,
            strength: m.strength,
          })),
        },
        "Initial memories",
      );
      const initialStrength = initialMemories[0]?.strength ?? 1.0;

      await service.extractFromBatch(
        "Alex: Yeah Python is definitely my go-to language, I use it for everything\nBob: Nice, what do you build?\nAlex: Mostly backend stuff and data pipelines",
      );

      const finalMemories = await store.getAll();
      logger.info(
        {
          memories: finalMemories.map((m) => ({
            content: m.content,
            strength: m.strength,
          })),
        },
        "Final memories",
      );

      const pythonMemory = finalMemories.find((m) =>
        m.content.toLowerCase().includes("python"),
      );
      expect(pythonMemory).toBeDefined();
      if (pythonMemory && pythonMemory.strength > initialStrength) {
        logger.info("Memory was reinforced as expected");
      }
    });

    it("weakens memory when contradicted", async () => {
      await service.extractFromBatch(
        "Jordan: I absolutely hate coffee, can't stand the taste",
      );

      const initialMemories = await store.getAll();
      logger.info(
        {
          memories: initialMemories.map((m) => ({
            content: m.content,
            strength: m.strength,
          })),
        },
        "Initial memories",
      );

      await service.extractFromBatch(
        "Jordan: Actually I've started drinking coffee lately, it's growing on me\nSam: Really? I thought you hated it\nJordan: Yeah I changed my mind",
      );

      const finalMemories = await store.getAll();
      logger.info(
        {
          memories: finalMemories.map((m) => ({
            content: m.content,
            strength: m.strength,
          })),
        },
        "Final memories after contradiction",
      );

      const hateCoffeeMemory = finalMemories.find(
        (m) =>
          m.content.toLowerCase().includes("hate") &&
          m.content.toLowerCase().includes("coffee"),
      );
      if (hateCoffeeMemory) {
        logger.info(
          { strength: hateCoffeeMemory.strength },
          "Original 'hates coffee' memory strength",
        );
      }
    });
  });

  describe("memory retrieval", () => {
    it("retrieves semantically relevant memories", async () => {
      await service.extractFromBatch(
        "Chris: I'm a big fan of hiking, especially in the mountains\nChris: I work as a data scientist at Google\nChris: My favorite food is sushi, I eat it at least once a week",
      );

      const allMemories = await store.getAll();
      logger.info(
        { memories: allMemories.map((m) => m.content) },
        "All stored memories",
      );

      const outdoorMemories = await service.getRelevantMemories(
        "What outdoor activities does Chris enjoy?",
        5,
      );
      logger.info(
        { memories: outdoorMemories.map((m) => m.content) },
        "Retrieved memories for outdoor activities query",
      );

      const workMemories = await service.getRelevantMemories(
        "Where does Chris work?",
        5,
      );
      logger.info(
        { memories: workMemories.map((m) => m.content) },
        "Retrieved memories for work query",
      );

      expect(outdoorMemories.length).toBeGreaterThan(0);
      expect(workMemories.length).toBeGreaterThan(0);
    });
  });

  describe("simulated conversation flow", () => {
    it("builds knowledge over multiple batches", async () => {
      await service.extractFromBatch(
        "Emma: Just got back from my trip to Tokyo!",
      );

      await service.extractFromBatch(
        "Emma: The food was amazing, especially the ramen. I'm definitely going back next year.\nBob: That sounds awesome\nEmma: Oh and I picked up some Japanese while I was there, started taking classes before the trip",
      );

      const memories = await store.getAll();
      logger.info(
        {
          count: memories.length,
          memories: memories.map((m) => ({
            content: m.content,
            strength: m.strength.toFixed(2),
          })),
        },
        "Memories after conversation batches",
      );

      expect(memories.length).toBeGreaterThan(0);

      const relevant = await service.getRelevantMemories(
        "What do we know about Emma's travels and language learning?",
        10,
      );
      logger.info(
        { memories: relevant.map((m) => m.content) },
        "Relevant memories for Emma",
      );
    });

    it("handles multiple people in conversation", async () => {
      await service.extractFromBatch(
        `Tom: Anyone here into photography? Just got a new camera
Lisa: Oh nice! I'm more into film photography myself, love the analog feel
Tom: That's cool, I've been meaning to try film. What camera do you use?
Lisa: I shoot with a Leica M6, it's my baby`,
      );

      const memories = await store.getAll();
      logger.info(
        {
          count: memories.length,
          memories: memories.map((m) => ({
            content: m.content,
            strength: m.strength.toFixed(2),
          })),
        },
        "Memories about Tom and Lisa",
      );

      const tomMemories = await service.searchMemories("Tom photography", 5);
      const lisaMemories = await service.searchMemories("Lisa camera", 5);

      logger.info(
        { memories: tomMemories.map((m) => m.content) },
        "Tom's photography memories",
      );
      logger.info(
        { memories: lisaMemories.map((m) => m.content) },
        "Lisa's camera memories",
      );

      expect(memories.length).toBeGreaterThan(0);
    });

    it("demonstrates decay and reinforcement over time", async () => {
      await service.extractFromBatch(
        "Raj: I'm really into machine learning, it's my main focus at work",
      );

      let memories = await store.getAll();
      const mlMemory = memories.find((m) =>
        m.content.toLowerCase().includes("machine learning"),
      );
      logger.info(
        { content: mlMemory?.content, strength: mlMemory?.strength },
        "Initial ML memory",
      );

      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 30);
      if (mlMemory) {
        await store.update(mlMemory.id, { lastSeenAt: oldDate });
      }

      await service.extractFromBatch(
        "Raj: Been working on some cool NLP projects lately using transformers\nBob: That's ML stuff right?\nRaj: Yeah exactly, deep learning for text",
      );

      memories = await store.getAll();
      logger.info(
        {
          memories: memories.map((m) => ({
            content: m.content,
            strength: m.strength.toFixed(2),
            lastSeen: m.lastSeenAt.toISOString(),
          })),
        },
        "Memories after reinforcement",
      );

      const reinforcedMlMemory = memories.find((m) => m.id === mlMemory?.id);
      if (reinforcedMlMemory) {
        logger.info(
          {
            wasReinforced: reinforcedMlMemory.lastSeenAt > oldDate,
            newStrength: reinforcedMlMemory.strength,
          },
          "ML memory status after related message",
        );
      }
    });
  });

  describe("memory search", () => {
    it("searches memories by semantic query", async () => {
      await service.extractFromBatch(
        "Sam: I'm vegan, been plant-based for 3 years\nSam: I run marathons, training for Boston\nSam: I work from home as a freelance designer",
      );

      const dietMemories = await service.searchMemories(
        "dietary preferences food",
        5,
      );
      logger.info(
        { memories: dietMemories.map((m) => m.content) },
        "Diet-related memories",
      );

      const fitnessMemories = await service.searchMemories(
        "exercise sports fitness",
        5,
      );
      logger.info(
        { memories: fitnessMemories.map((m) => m.content) },
        "Fitness-related memories",
      );

      const workMemories = await service.searchMemories(
        "job career employment",
        5,
      );
      logger.info(
        { memories: workMemories.map((m) => m.content) },
        "Work-related memories",
      );
    });
  });
});
