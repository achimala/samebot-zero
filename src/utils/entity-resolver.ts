import type { SupabaseClient } from "../supabase/client";
import type { Logger } from "pino";
import type { ReferenceImage } from "./emoji-generator";

const MAX_REFERENCE_IMAGES = 3;

export interface ResolvedEntity {
  originalName: string;
  folderName: string;
  rewrittenPrompt: string;
  referenceImages: ReferenceImage[];
}

export class EntityResolver {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly logger: Logger,
  ) {}

  async resolve(prompt: string): Promise<ResolvedEntity | null> {
    const folders = await this.supabase.listEntityFolders();
    if (folders.length === 0) {
      return null;
    }

    const words = this.extractWords(prompt);
    let bestMatch: { word: string; folder: string; score: number } | null =
      null;

    for (const word of words) {
      for (const folder of folders) {
        const score = this.fuzzyMatchScore(word.toLowerCase(), folder.toLowerCase());
        if (score > 0.7 && (!bestMatch || score > bestMatch.score)) {
          bestMatch = { word, folder, score };
        }
      }
    }

    if (!bestMatch) {
      return null;
    }

    this.logger.info(
      { word: bestMatch.word, folder: bestMatch.folder, score: bestMatch.score },
      "Matched entity in prompt",
    );

    const files = await this.supabase.listFilesInFolder(bestMatch.folder);
    if (files.length === 0) {
      this.logger.warn(
        { folder: bestMatch.folder },
        "Matched folder has no images",
      );
      return null;
    }

    const selectedFiles = this.selectRandomItems(files, MAX_REFERENCE_IMAGES);
    const referenceImages: ReferenceImage[] = [];

    for (const file of selectedFiles) {
      const image = await this.supabase.downloadImage(bestMatch.folder, file.name);
      if (image) {
        referenceImages.push(image);
      }
    }

    if (referenceImages.length === 0) {
      this.logger.warn(
        { folder: bestMatch.folder },
        "Failed to download any reference images",
      );
      return null;
    }

    const rewrittenPrompt = this.rewritePrompt(prompt, bestMatch.word);

    this.logger.info(
      {
        originalPrompt: prompt,
        rewrittenPrompt,
        entityName: bestMatch.word,
        folder: bestMatch.folder,
        imageCount: referenceImages.length,
      },
      "Resolved entity with reference images",
    );

    return {
      originalName: bestMatch.word,
      folderName: bestMatch.folder,
      rewrittenPrompt,
      referenceImages,
    };
  }

  private extractWords(text: string): string[] {
    return text.split(/\s+/).filter((word) => word.length >= 2);
  }

  private fuzzyMatchScore(search: string, target: string): number {
    if (search === target) {
      return 1.0;
    }

    if (target.includes(search) || search.includes(target)) {
      const shorter = Math.min(search.length, target.length);
      const longer = Math.max(search.length, target.length);
      return shorter / longer;
    }

    const distance = this.levenshteinDistance(search, target);
    const maxLength = Math.max(search.length, target.length);
    return 1 - distance / maxLength;
  }

  private levenshteinDistance(stringA: string, stringB: string): number {
    const lengthA = stringA.length;
    const lengthB = stringB.length;
    const matrix: number[][] = Array.from({ length: lengthB + 1 }, () =>
      Array.from({ length: lengthA + 1 }, () => 0),
    );

    for (let i = 0; i <= lengthB; i++) {
      matrix[i]![0] = i;
    }

    for (let j = 0; j <= lengthA; j++) {
      matrix[0]![j] = j;
    }

    for (let i = 1; i <= lengthB; i++) {
      for (let j = 1; j <= lengthA; j++) {
        if (stringB.charAt(i - 1) === stringA.charAt(j - 1)) {
          matrix[i]![j] = matrix[i - 1]![j - 1]!;
        } else {
          matrix[i]![j] = Math.min(
            matrix[i - 1]![j - 1]! + 1,
            matrix[i]![j - 1]! + 1,
            matrix[i - 1]![j]! + 1,
          );
        }
      }
    }

    return matrix[lengthB]![lengthA]!;
  }

  private rewritePrompt(prompt: string, entityName: string): string {
    const regex = new RegExp(`\\b${this.escapeRegex(entityName)}\\b`, "gi");
    return prompt.replace(regex, "this person");
  }

  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private selectRandomItems<T>(items: T[], count: number): T[] {
    if (items.length <= count) {
      return [...items];
    }

    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const randomIndex = Math.floor(Math.random() * (i + 1));
      const temp = shuffled[i]!;
      shuffled[i] = shuffled[randomIndex]!;
      shuffled[randomIndex] = temp;
    }

    return shuffled.slice(0, count);
  }
}

