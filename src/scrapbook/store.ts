export interface ContextMessage {
  author: string;
  content: string;
  timestamp: number;
}

export interface ScrapbookMemory {
  id: string;
  keyMessage: string;
  author: string;
  context: ContextMessage[];
  createdAt: Date;
}

export interface ScrapbookStore {
  insert(memory: Omit<ScrapbookMemory, "id">): Promise<string>;
  delete(id: string): Promise<void>;
  getRandom(): Promise<ScrapbookMemory | null>;
  search(query: string, limit?: number): Promise<ScrapbookMemory[]>;
  getById(id: string): Promise<ScrapbookMemory | null>;
}
