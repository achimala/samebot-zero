import Fuse from "fuse.js";
import type { SupabaseClient } from "../supabase/client";
import type { Logger } from "pino";
import type { ReferenceImage } from "./emoji-generator";

const MAX_REFERENCE_IMAGES_PER_ENTITY = 3;
const FUSE_THRESHOLD = 0.25;

interface SearchableEntity {
  searchTerm: string;
  folderName: string;
}

export interface ResolvedEntity {
  name: string;
  folderName: string;
  referenceImages: ReferenceImage[];
}

export interface EntityResolutionResult {
  entities: ResolvedEntity[];
  originalPrompt: string;
}

export class EntityResolver {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly logger: Logger,
  ) {}

  async resolve(prompt: string): Promise<EntityResolutionResult | null> {
    this.logger.info({ prompt }, "Resolving entities");
    const folders = await this.supabase.listEntityFolders();
    this.logger.info({ folders }, "Available entity folders");
    if (folders.length === 0) {
      return null;
    }

    const searchableEntities = await this.buildSearchIndex(folders);

    const fuse = new Fuse(searchableEntities, {
      keys: ["searchTerm"],
      threshold: FUSE_THRESHOLD,
      includeScore: true,
    });

    const words = this.extractWords(prompt);
    const matchedEntities = new Map<
      string,
      { word: string; folder: string; score: number }
    >();

    for (const word of words) {
      const results = fuse.search(word);
      if (results.length > 0) {
        const topResult = results[0]!;
        const score = 1 - (topResult.score ?? 0);
        const folderName = topResult.item.folderName;

        const existingMatch = matchedEntities.get(folderName);
        if (!existingMatch || score > existingMatch.score) {
          matchedEntities.set(folderName, {
            word,
            folder: folderName,
            score,
          });
        }
      }
    }

    if (matchedEntities.size === 0) {
      return null;
    }

    this.logger.info(
      { matches: Array.from(matchedEntities.values()) },
      "Matched entities in prompt",
    );

    const entities: ResolvedEntity[] = [];

    for (const match of matchedEntities.values()) {
      const files = await this.supabase.listFilesInFolder(match.folder);
      if (files.length === 0) {
        this.logger.warn(
          { folder: match.folder },
          "Matched folder has no images",
        );
        continue;
      }

      const selectedFiles = this.selectRandomItems(
        files,
        MAX_REFERENCE_IMAGES_PER_ENTITY,
      );
      const referenceImages: ReferenceImage[] = [];

      for (const file of selectedFiles) {
        const image = await this.supabase.downloadImage(
          match.folder,
          file.name,
        );
        if (image) {
          referenceImages.push(image);
        }
      }

      if (referenceImages.length === 0) {
        this.logger.warn(
          { folder: match.folder },
          "Failed to download any reference images",
        );
        continue;
      }

      entities.push({
        name: match.folder,
        folderName: match.folder,
        referenceImages,
      });
    }

    if (entities.length === 0) {
      return null;
    }

    this.logger.info(
      {
        originalPrompt: prompt,
        entityCount: entities.length,
        entities: entities.map((entity) => ({
          name: entity.name,
          imageCount: entity.referenceImages.length,
        })),
      },
      "Resolved entities with reference images",
    );

    return {
      entities,
      originalPrompt: prompt,
    };
  }

  buildPromptWithReferences(result: EntityResolutionResult): {
    textPrompt: string;
    referenceImages: ReferenceImage[];
  } {
    const referenceImageSections: string[] = [];
    const allReferenceImages: ReferenceImage[] = [];

    for (const entity of result.entities) {
      const imageCount = entity.referenceImages.length;
      referenceImageSections.push(
        `Reference images of ${entity.name} (use as references for generation, not to be directly pasted): [${imageCount} image${imageCount !== 1 ? "s" : ""} attached]`,
      );
      allReferenceImages.push(...entity.referenceImages);
    }

    const textPrompt = `${referenceImageSections.join("\n")}\n\n${result.originalPrompt}`;

    return {
      textPrompt,
      referenceImages: allReferenceImages,
    };
  }

  private async buildSearchIndex(
    folders: string[],
  ): Promise<SearchableEntity[]> {
    const searchableEntities: SearchableEntity[] = [];

    for (const folder of folders) {
      searchableEntities.push({ searchTerm: folder, folderName: folder });

      const aliases = await this.supabase.getEntityAliases(folder);
      for (const alias of aliases) {
        searchableEntities.push({ searchTerm: alias, folderName: folder });
      }
    }

    return searchableEntities;
  }

  private extractWords(text: string): string[] {
    return text.split(/\s+/).filter((word) => word.length >= 2);
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
