import {
  createClient,
  type SupabaseClient as SupabaseClientType,
} from "@supabase/supabase-js";
import type { Logger } from "pino";
import type { AppConfig } from "../core/config";

export interface UserGitHubToken {
  discordUserId: string;
  githubToken: string;
  createdAt: string;
  updatedAt: string;
}

export interface StorageFile {
  name: string;
  id: string;
}

const ENTITY_REFERENCES_BUCKET = "reference-images";

export class SupabaseClient {
  private client: SupabaseClientType;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
  }

  async getGitHubToken(discordUserId: string): Promise<string | null> {
    try {
      const { data, error } = await this.client
        .from("user_github_tokens")
        .select("github_token")
        .eq("discord_user_id", discordUserId)
        .single();

      if (error) {
        if (error.code === "PGRST116") {
          return null;
        }
        this.logger.error(
          { err: error, discordUserId },
          "Failed to get GitHub token",
        );
        return null;
      }

      return data?.github_token ?? null;
    } catch (error) {
      this.logger.error(
        { err: error, discordUserId },
        "Error getting GitHub token",
      );
      return null;
    }
  }

  async setGitHubToken(
    discordUserId: string,
    githubToken: string,
  ): Promise<boolean> {
    try {
      const { error } = await this.client.from("user_github_tokens").upsert(
        {
          discord_user_id: discordUserId,
          github_token: githubToken,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "discord_user_id",
        },
      );

      if (error) {
        this.logger.error(
          { err: error, discordUserId },
          "Failed to set GitHub token",
        );
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error(
        { err: error, discordUserId },
        "Error setting GitHub token",
      );
      return false;
    }
  }

  async listEntityFolders(): Promise<string[]> {
    try {
      const { data, error } = await this.client.storage
        .from(ENTITY_REFERENCES_BUCKET)
        .list("", { limit: 100 });

      if (error) {
        this.logger.error({ err: error }, "Failed to list entity folders");
        return [];
      }

      return data.filter((item) => item.id === null).map((item) => item.name);
    } catch (error) {
      this.logger.error({ err: error }, "Error listing entity folders");
      return [];
    }
  }

  async listFilesInFolder(folderName: string): Promise<StorageFile[]> {
    try {
      const { data, error } = await this.client.storage
        .from(ENTITY_REFERENCES_BUCKET)
        .list(folderName, { limit: 100 });

      if (error) {
        this.logger.error(
          { err: error, folderName },
          "Failed to list files in folder",
        );
        return [];
      }

      return data
        .filter((item) => item.id !== null)
        .map((item) => ({ name: item.name, id: item.id! }));
    } catch (error) {
      this.logger.error(
        { err: error, folderName },
        "Error listing files in folder",
      );
      return [];
    }
  }

  async downloadImage(
    folderName: string,
    fileName: string,
  ): Promise<{ data: string; mimeType: string } | null> {
    try {
      const path = `${folderName}/${fileName}`;
      const { data, error } = await this.client.storage
        .from(ENTITY_REFERENCES_BUCKET)
        .download(path);

      if (error) {
        this.logger.error({ err: error, path }, "Failed to download image");
        return null;
      }

      const arrayBuffer = await data.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      const mimeType = this.getMimeTypeFromFileName(fileName);

      return { data: base64, mimeType };
    } catch (error) {
      this.logger.error(
        { err: error, folderName, fileName },
        "Error downloading image",
      );
      return null;
    }
  }

  async uploadEntityImage(
    folderName: string,
    imageBuffer: Buffer,
    mimeType: string,
  ): Promise<{ path: string } | null> {
    try {
      const extension = this.getExtensionFromMimeType(mimeType);
      const fileName = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${extension}`;
      const path = `${folderName}/${fileName}`;

      const { error } = await this.client.storage
        .from(ENTITY_REFERENCES_BUCKET)
        .upload(path, imageBuffer, {
          contentType: mimeType,
          upsert: false,
        });

      if (error) {
        this.logger.error(
          { err: error, path },
          "Failed to upload entity image",
        );
        return null;
      }

      this.logger.info({ path, folderName }, "Uploaded entity reference image");
      return { path };
    } catch (error) {
      this.logger.error(
        { err: error, folderName },
        "Error uploading entity image",
      );
      return null;
    }
  }

  private getMimeTypeFromFileName(fileName: string): string {
    const extension = fileName.split(".").pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
    };
    return mimeTypes[extension ?? ""] ?? "image/jpeg";
  }

  private getExtensionFromMimeType(mimeType: string): string {
    const extensions: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
    };
    return extensions[mimeType] ?? "jpg";
  }
}
