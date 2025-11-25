import type { SupabaseClient as SupabaseClientType } from "@supabase/supabase-js";
import type { Logger } from "pino";
import type { Memory, MemoryStore } from "./store";

interface MemoryRow {
  id: string;
  content: string;
  embedding: string;
  strength: number;
  last_seen_at: string;
  created_at: string;
}

export class SupabaseMemoryStore implements MemoryStore {
  constructor(
    private readonly client: SupabaseClientType,
    private readonly logger: Logger,
  ) {}

  async insert(memory: Omit<Memory, "id">): Promise<string> {
    const embeddingString = `[${memory.embedding.join(",")}]`;

    const { data, error } = await this.client
      .from("memories")
      .insert({
        content: memory.content,
        embedding: embeddingString,
        strength: memory.strength,
        last_seen_at: memory.lastSeenAt.toISOString(),
        created_at: memory.createdAt.toISOString(),
      })
      .select("id")
      .single();

    if (error) {
      this.logger.error({ err: error }, "Failed to insert memory");
      throw error;
    }

    return data.id;
  }

  async update(
    id: string,
    updates: Partial<Omit<Memory, "id">>,
  ): Promise<void> {
    const updateData: Record<string, unknown> = {};

    if (updates.content !== undefined) {
      updateData.content = updates.content;
    }
    if (updates.embedding !== undefined) {
      updateData.embedding = `[${updates.embedding.join(",")}]`;
    }
    if (updates.strength !== undefined) {
      updateData.strength = updates.strength;
    }
    if (updates.lastSeenAt !== undefined) {
      updateData.last_seen_at = updates.lastSeenAt.toISOString();
    }

    const { error } = await this.client
      .from("memories")
      .update(updateData)
      .eq("id", id);

    if (error) {
      this.logger.error({ err: error, id }, "Failed to update memory");
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    const { error } = await this.client.from("memories").delete().eq("id", id);

    if (error) {
      this.logger.error({ err: error, id }, "Failed to delete memory");
      throw error;
    }
  }

  async findSimilar(embedding: number[], topK: number): Promise<Memory[]> {
    const embeddingString = `[${embedding.join(",")}]`;

    const { data, error } = await this.client.rpc("match_memories", {
      query_embedding: embeddingString,
      match_count: topK,
    });

    if (error) {
      this.logger.error({ err: error }, "Failed to find similar memories");
      throw error;
    }

    return (data as MemoryRow[]).map((row) => this.rowToMemory(row));
  }

  async findByStrengthAbove(threshold: number): Promise<Memory[]> {
    const { data, error } = await this.client
      .from("memories")
      .select("*")
      .gt("strength", threshold);

    if (error) {
      this.logger.error({ err: error }, "Failed to find memories by strength");
      throw error;
    }

    return (data as MemoryRow[]).map((row) => this.rowToMemory(row));
  }

  async getAll(): Promise<Memory[]> {
    const { data, error } = await this.client.from("memories").select("*");

    if (error) {
      this.logger.error({ err: error }, "Failed to get all memories");
      throw error;
    }

    return (data as MemoryRow[]).map((row) => this.rowToMemory(row));
  }

  private rowToMemory(row: MemoryRow): Memory {
    let embedding: number[];
    if (typeof row.embedding === "string") {
      embedding = JSON.parse(row.embedding) as number[];
    } else {
      embedding = row.embedding as unknown as number[];
    }

    return {
      id: row.id,
      content: row.content,
      embedding,
      strength: row.strength,
      lastSeenAt: new Date(row.last_seen_at),
      createdAt: new Date(row.created_at),
    };
  }
}
