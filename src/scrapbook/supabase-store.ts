import type { SupabaseClient as SupabaseClientType } from "@supabase/supabase-js";
import type { Logger } from "pino";
import type { ScrapbookMemory, ScrapbookStore, ContextMessage } from "./store";

interface ScrapbookRow {
  id: string;
  key_message: string;
  author: string;
  context: ContextMessage[];
  created_at: string;
}

export class SupabaseScrapbookStore implements ScrapbookStore {
  constructor(
    private readonly client: SupabaseClientType,
    private readonly logger: Logger,
  ) {}

  async insert(memory: Omit<ScrapbookMemory, "id">): Promise<string> {
    const { data, error } = await this.client
      .from("scrapbook_memories")
      .insert({
        key_message: memory.keyMessage,
        author: memory.author,
        context: memory.context,
        created_at: memory.createdAt.toISOString(),
      })
      .select("id")
      .single();

    if (error) {
      this.logger.error({ err: error }, "Failed to insert scrapbook memory");
      throw error;
    }

    return data.id;
  }

  async delete(id: string): Promise<void> {
    const { error } = await this.client
      .from("scrapbook_memories")
      .delete()
      .eq("id", id);

    if (error) {
      this.logger.error(
        { err: error, id },
        "Failed to delete scrapbook memory",
      );
      throw error;
    }
  }

  async getRandom(): Promise<ScrapbookMemory | null> {
    const { data, error } = await this.client.rpc(
      "get_random_scrapbook_memory",
    );

    if (error) {
      this.logger.error(
        { err: error },
        "Failed to get random scrapbook memory",
      );
      throw error;
    }

    if (!data || data.length === 0) {
      return null;
    }

    return this.rowToMemory(data[0] as ScrapbookRow);
  }

  async search(query: string, limit: number = 10): Promise<ScrapbookMemory[]> {
    const { data, error } = await this.client.rpc("search_scrapbook_memories", {
      search_query: query,
      result_limit: limit,
    });

    if (error) {
      this.logger.error({ err: error }, "Failed to search scrapbook memories");
      throw error;
    }

    return (data as ScrapbookRow[]).map((row) => this.rowToMemory(row));
  }

  async getById(id: string): Promise<ScrapbookMemory | null> {
    const { data, error } = await this.client
      .from("scrapbook_memories")
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return null;
      }
      this.logger.error(
        { err: error, id },
        "Failed to get scrapbook memory by id",
      );
      throw error;
    }

    return this.rowToMemory(data as ScrapbookRow);
  }

  async getByQuote(quote: string): Promise<ScrapbookMemory | null> {
    const { data, error } = await this.client
      .from("scrapbook_memories")
      .select("*")
      .eq("key_message", quote)
      .limit(1)
      .maybeSingle();

    if (error) {
      this.logger.error(
        { err: error, quote },
        "Failed to get scrapbook memory by quote",
      );
      throw error;
    }

    if (!data) {
      return null;
    }

    return this.rowToMemory(data as ScrapbookRow);
  }

  private rowToMemory(row: ScrapbookRow): ScrapbookMemory {
    return {
      id: row.id,
      keyMessage: row.key_message,
      author: row.author,
      context: row.context,
      createdAt: new Date(row.created_at),
    };
  }
}
