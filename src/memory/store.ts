export interface Memory {
  id: string;
  content: string;
  embedding: number[];
  strength: number;
  lastSeenAt: Date;
  createdAt: Date;
}

export interface MemoryStore {
  insert(memory: Omit<Memory, "id">): Promise<string>;
  update(id: string, updates: Partial<Omit<Memory, "id">>): Promise<void>;
  delete(id: string): Promise<void>;
  findSimilar(embedding: number[], topK: number): Promise<Memory[]>;
  findByStrengthAbove(threshold: number): Promise<Memory[]>;
  getAll(): Promise<Memory[]>;
}

function cosineSimilarity(vectorA: number[], vectorB: number[]): number {
  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < vectorA.length; i++) {
    const valueA = vectorA[i]!;
    const valueB = vectorB[i]!;
    dotProduct += valueA * valueB;
    magnitudeA += valueA * valueA;
    magnitudeB += valueB * valueB;
  }

  magnitudeA = Math.sqrt(magnitudeA);
  magnitudeB = Math.sqrt(magnitudeB);

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dotProduct / (magnitudeA * magnitudeB);
}

export class InMemoryStore implements MemoryStore {
  private memories: Map<string, Memory> = new Map();
  private nextId = 1;

  async insert(memory: Omit<Memory, "id">): Promise<string> {
    const id = `mem_${this.nextId++}`;
    this.memories.set(id, { ...memory, id });
    return id;
  }

  async update(
    id: string,
    updates: Partial<Omit<Memory, "id">>,
  ): Promise<void> {
    const existing = this.memories.get(id);
    if (!existing) {
      throw new Error(`Memory ${id} not found`);
    }
    this.memories.set(id, { ...existing, ...updates });
  }

  async delete(id: string): Promise<void> {
    this.memories.delete(id);
  }

  async findSimilar(embedding: number[], topK: number): Promise<Memory[]> {
    const memoriesWithSimilarity = Array.from(this.memories.values()).map(
      (memory) => ({
        memory,
        similarity: cosineSimilarity(embedding, memory.embedding),
      }),
    );

    memoriesWithSimilarity.sort((a, b) => b.similarity - a.similarity);

    return memoriesWithSimilarity.slice(0, topK).map((item) => item.memory);
  }

  async findByStrengthAbove(threshold: number): Promise<Memory[]> {
    return Array.from(this.memories.values()).filter(
      (memory) => memory.strength > threshold,
    );
  }

  async getAll(): Promise<Memory[]> {
    return Array.from(this.memories.values());
  }

  clear(): void {
    this.memories.clear();
    this.nextId = 1;
  }
}
