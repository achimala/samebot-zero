import { createClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import type { AppConfig } from "../core/config";

export interface UserGitHubToken {
  discordUserId: string;
  githubToken: string;
  createdAt: string;
  updatedAt: string;
}

export class SupabaseClient {
  private client;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.client = createClient(config.supabaseUrl, config.supabaseAnonKey);
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
}
