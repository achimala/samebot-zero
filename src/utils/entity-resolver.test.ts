import { describe, it, expect } from "vitest";
import { EntityResolver } from "./entity-resolver";
import type { SupabaseClient } from "../supabase/client";
import type { Logger } from "pino";
import { createLogger } from "../core/logger";

function createMockSupabaseClient(
  entityFolders: string[],
  entityFiles: Record<string, Array<{ name: string; id: string }>> = {},
  entityAliases: Record<string, string[]> = {},
): SupabaseClient {
  return {
    listEntityFolders: async () => entityFolders,
    listFilesInFolder: async (folderName: string) =>
      entityFiles[folderName] || [],
    getEntityAliases: async (folderName: string) =>
      entityAliases[folderName] || [],
    downloadImage: async (folderName: string, fileName: string) => ({
      data: "fake-base64-data",
      mimeType: "image/jpeg",
    }),
  } as unknown as SupabaseClient;
}

function createMockLogger(): Logger {
  return createLogger("silent");
}

describe("EntityResolver", () => {
  const mockLogger = createMockLogger();

  describe("should not match false positives", () => {
    it("should not match 'an' to 'anshu'", async () => {
      const mockSupabase = createMockSupabaseClient(
        ["anshu"],
        { anshu: [{ name: "image1.jpg", id: "1" }] },
      );
      const resolver = new EntityResolver(mockSupabase, mockLogger);

      const prompt =
        'tyrus with his skin slightly peeling off revealing a robotic interior, saying "in not an llm 😡". Puffed cheeks';

      const result = await resolver.resolve(prompt);

      expect(result).toBeNull();
    });

    it("should not match 'in' to any entity", async () => {
      const mockSupabase = createMockSupabaseClient(
        ["anshu", "tyrus"],
        {
          anshu: [{ name: "image1.jpg", id: "1" }],
          tyrus: [{ name: "image2.jpg", id: "2" }],
        },
      );
      const resolver = new EntityResolver(mockSupabase, mockLogger);

      const prompt = "in the middle of nowhere";

      const result = await resolver.resolve(prompt);

      expect(result).toBeNull();
    });

    it("should not match short common words to entities", async () => {
      const mockSupabase = createMockSupabaseClient(
        ["anshu", "tyrus", "office-cat"],
        {
          anshu: [{ name: "image1.jpg", id: "1" }],
          tyrus: [{ name: "image2.jpg", id: "2" }],
          "office-cat": [{ name: "image3.jpg", id: "3" }],
        },
      );
      const resolver = new EntityResolver(mockSupabase, mockLogger);

      const prompt = "an apple a day keeps the doctor away";

      const result = await resolver.resolve(prompt);

      expect(result).toBeNull();
    });

    it("should not match 'at' to 'cat'", async () => {
      const mockSupabase = createMockSupabaseClient(
        ["office-cat"],
        { "office-cat": [{ name: "image1.jpg", id: "1" }] },
      );
      const resolver = new EntityResolver(mockSupabase, mockLogger);

      const prompt = "look at this picture";

      const result = await resolver.resolve(prompt);

      expect(result).toBeNull();
    });
  });

  describe("should match exact entity names", () => {
    it("should match exact entity name 'tyrus'", async () => {
      const mockSupabase = createMockSupabaseClient(
        ["tyrus", "anshu"],
        {
          tyrus: [{ name: "tyrus1.jpg", id: "1" }],
        },
      );
      const resolver = new EntityResolver(mockSupabase, mockLogger);

      const prompt = "generate an image of tyrus";

      const result = await resolver.resolve(prompt);

      expect(result).not.toBeNull();
      expect(result?.entities).toHaveLength(1);
      expect(result?.entities[0]?.name).toBe("tyrus");
    });

    it("should match exact entity name case-insensitively", async () => {
      const mockSupabase = createMockSupabaseClient(
        ["tyrus"],
        { tyrus: [{ name: "tyrus1.jpg", id: "1" }] },
      );
      const resolver = new EntityResolver(mockSupabase, mockLogger);

      const prompt = "generate an image of TYRUS";

      const result = await resolver.resolve(prompt);

      expect(result).not.toBeNull();
      expect(result?.entities).toHaveLength(1);
      expect(result?.entities[0]?.name).toBe("tyrus");
    });

    it("should match exact entity name with punctuation", async () => {
      const mockSupabase = createMockSupabaseClient(
        ["office-cat"],
        { "office-cat": [{ name: "cat1.jpg", id: "1" }] },
      );
      const resolver = new EntityResolver(mockSupabase, mockLogger);

      const prompt = "generate an image of office-cat!";

      const result = await resolver.resolve(prompt);

      expect(result).not.toBeNull();
      expect(result?.entities).toHaveLength(1);
      expect(result?.entities[0]?.name).toBe("office-cat");
    });
  });

  describe("should match fuzzy similar names", () => {
    it("should match 'ansh' to 'anshu'", async () => {
      const mockSupabase = createMockSupabaseClient(
        ["anshu"],
        { anshu: [{ name: "anshu1.jpg", id: "1" }] },
      );
      const resolver = new EntityResolver(mockSupabase, mockLogger);

      const prompt = "generate an image of ansh";

      const result = await resolver.resolve(prompt);

      expect(result).not.toBeNull();
      expect(result?.entities).toHaveLength(1);
      expect(result?.entities[0]?.name).toBe("anshu");
    });

    it("should match 'tyrus' with typo 'tyruss'", async () => {
      const mockSupabase = createMockSupabaseClient(
        ["tyrus"],
        { tyrus: [{ name: "tyrus1.jpg", id: "1" }] },
      );
      const resolver = new EntityResolver(mockSupabase, mockLogger);

      const prompt = "generate an image of tyruss";

      const result = await resolver.resolve(prompt);

      expect(result).not.toBeNull();
      expect(result?.entities).toHaveLength(1);
      expect(result?.entities[0]?.name).toBe("tyrus");
    });

    it("should not match 'tyrus' with too many typos 'tyrusss'", async () => {
      const mockSupabase = createMockSupabaseClient(
        ["tyrus"],
        { tyrus: [{ name: "tyrus1.jpg", id: "1" }] },
      );
      const resolver = new EntityResolver(mockSupabase, mockLogger);

      const prompt = "generate an image of tyrusss";

      const result = await resolver.resolve(prompt);

      expect(result).toBeNull();
    });

    it("should match 'tyru' to 'tyrus' (4/5 = 0.8 ratio)", async () => {
      const mockSupabase = createMockSupabaseClient(
        ["tyrus"],
        { tyrus: [{ name: "tyrus1.jpg", id: "1" }] },
      );
      const resolver = new EntityResolver(mockSupabase, mockLogger);

      const prompt = "generate an image of tyru";

      const result = await resolver.resolve(prompt);

      expect(result).not.toBeNull();
      expect(result?.entities).toHaveLength(1);
      expect(result?.entities[0]?.name).toBe("tyrus");
    });

    it("should not match 'ans' to 'anshu' (3/5 = 0.6 ratio)", async () => {
      const mockSupabase = createMockSupabaseClient(
        ["anshu"],
        { anshu: [{ name: "anshu1.jpg", id: "1" }] },
      );
      const resolver = new EntityResolver(mockSupabase, mockLogger);

      const prompt = "generate an image of ans";

      const result = await resolver.resolve(prompt);

      expect(result).toBeNull();
    });

    it("should not match 'ty' to 'tyrus' (2/5 = 0.4 ratio)", async () => {
      const mockSupabase = createMockSupabaseClient(
        ["tyrus"],
        { tyrus: [{ name: "tyrus1.jpg", id: "1" }] },
      );
      const resolver = new EntityResolver(mockSupabase, mockLogger);

      const prompt = "generate an image of ty";

      const result = await resolver.resolve(prompt);

      expect(result).toBeNull();
    });
  });

  describe("should match aliases", () => {
    it("should match alias to entity", async () => {
      const mockSupabase = createMockSupabaseClient(
        ["tyrus"],
        { tyrus: [{ name: "tyrus1.jpg", id: "1" }] },
        { tyrus: ["tyrus-bot", "tyrus-robot"] },
      );
      const resolver = new EntityResolver(mockSupabase, mockLogger);

      const prompt = "generate an image of tyrus-bot";

      const result = await resolver.resolve(prompt);

      expect(result).not.toBeNull();
      expect(result?.entities).toHaveLength(1);
      expect(result?.entities[0]?.name).toBe("tyrus");
    });
  });

  describe("should match multiple entities", () => {
    it("should match multiple entities in one prompt", async () => {
      const mockSupabase = createMockSupabaseClient(
        ["tyrus", "anshu"],
        {
          tyrus: [{ name: "tyrus1.jpg", id: "1" }],
          anshu: [{ name: "anshu1.jpg", id: "2" }],
        },
      );
      const resolver = new EntityResolver(mockSupabase, mockLogger);

      const prompt = "generate an image of tyrus and anshu together";

      const result = await resolver.resolve(prompt);

      expect(result).not.toBeNull();
      expect(result?.entities).toHaveLength(2);
      const entityNames = result?.entities.map((e) => e.name).sort();
      expect(entityNames).toEqual(["anshu", "tyrus"]);
    });
  });

  describe("should handle edge cases", () => {
    it("should return null when no entities exist", async () => {
      const mockSupabase = createMockSupabaseClient([]);
      const resolver = new EntityResolver(mockSupabase, mockLogger);

      const prompt = "generate an image of tyrus";

      const result = await resolver.resolve(prompt);

      expect(result).toBeNull();
    });

    it("should return null when entity folder has no images", async () => {
      const mockSupabase = createMockSupabaseClient(["tyrus"]);
      const resolver = new EntityResolver(mockSupabase, mockLogger);

      const prompt = "generate an image of tyrus";

      const result = await resolver.resolve(prompt);

      expect(result).toBeNull();
    });

    it("should handle empty prompt", async () => {
      const mockSupabase = createMockSupabaseClient(
        ["tyrus"],
        { tyrus: [{ name: "tyrus1.jpg", id: "1" }] },
      );
      const resolver = new EntityResolver(mockSupabase, mockLogger);

      const prompt = "";

      const result = await resolver.resolve(prompt);

      expect(result).toBeNull();
    });

    it("should handle prompt with only single-character words", async () => {
      const mockSupabase = createMockSupabaseClient(
        ["tyrus"],
        { tyrus: [{ name: "tyrus1.jpg", id: "1" }] },
      );
      const resolver = new EntityResolver(mockSupabase, mockLogger);

      const prompt = "a b c d";

      const result = await resolver.resolve(prompt);

      expect(result).toBeNull();
    });
  });

  describe("buildPromptWithReferences", () => {
    it("should build prompt with reference images", () => {
      const mockSupabase = createMockSupabaseClient([]);
      const resolver = new EntityResolver(mockSupabase, mockLogger);

      const result = {
        entities: [
          {
            name: "tyrus",
            folderName: "tyrus",
            referenceImages: [
              { data: "data1", mimeType: "image/jpeg" },
              { data: "data2", mimeType: "image/jpeg" },
            ],
          },
        ],
        originalPrompt: "generate an image of tyrus",
      };

      const built = resolver.buildPromptWithReferences(result);

      expect(built.textPrompt).toContain(
        "Reference images of tyrus (use as references for generation",
      );
      expect(built.textPrompt).toContain("[2 images attached]");
      expect(built.textPrompt).toContain("generate an image of tyrus");
      expect(built.referenceImages).toHaveLength(2);
    });

    it("should handle singular image count", () => {
      const mockSupabase = createMockSupabaseClient([]);
      const resolver = new EntityResolver(mockSupabase, mockLogger);

      const result = {
        entities: [
          {
            name: "tyrus",
            folderName: "tyrus",
            referenceImages: [{ data: "data1", mimeType: "image/jpeg" }],
          },
        ],
        originalPrompt: "generate an image of tyrus",
      };

      const built = resolver.buildPromptWithReferences(result);

      expect(built.textPrompt).toContain("[1 image attached]");
    });

    it("should handle multiple entities", () => {
      const mockSupabase = createMockSupabaseClient([]);
      const resolver = new EntityResolver(mockSupabase, mockLogger);

      const result = {
        entities: [
          {
            name: "tyrus",
            folderName: "tyrus",
            referenceImages: [{ data: "data1", mimeType: "image/jpeg" }],
          },
          {
            name: "anshu",
            folderName: "anshu",
            referenceImages: [
              { data: "data2", mimeType: "image/jpeg" },
              { data: "data3", mimeType: "image/jpeg" },
            ],
          },
        ],
        originalPrompt: "generate an image of tyrus and anshu",
      };

      const built = resolver.buildPromptWithReferences(result);

      expect(built.textPrompt).toContain("Reference images of tyrus");
      expect(built.textPrompt).toContain("Reference images of anshu");
      expect(built.referenceImages).toHaveLength(3);
    });
  });
});
