import Fuse from "fuse.js";
import type { SupabaseClient } from "../supabase/client";
import type { Logger } from "pino";
import type { ReferenceImage } from "./emoji-generator";

const MAX_REFERENCE_IMAGES = 3;
const FUSE_THRESHOLD = 0.4;

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

    const fuse = new Fuse(folders, {
      threshold: FUSE_THRESHOLD,
      includeScore: true,
    });

    const words = this.extractWords(prompt);
    let bestMatch: { word: string; folder: string; score: number } | null =
      null;

    for (const word of words) {
      const results = fuse.search(word);
      if (results.length > 0) {
        const topResult = results[0]!;
        const score = 1 - (topResult.score ?? 0);
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = { word, folder: topResult.item, score };
        }
      }
    }

    if (!bestMatch) {
      return null;
    }

    this.logger.info(
      {
        word: bestMatch.word,
        folder: bestMatch.folder,
        score: bestMatch.score,
      },
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
      const image = await this.supabase.downloadImage(
        bestMatch.folder,
        file.name,
      );
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
