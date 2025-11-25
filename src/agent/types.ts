import type { ToolCall } from "../openai/client";

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  author?: string;
  timestamp: number;
  images?: string[];
}

export interface AgentContext {
  history: AgentMessage[];
  isDm: boolean;
  channelId: string;
  lastScrapbookMemoryId?: string;
}

export interface IncomingMessage {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  channelId: string;
  timestamp: number;
  images: string[];
  isDm: boolean;
  mentionsBotId: boolean;
}

export type ToolResult =
  | { success: true; message: string }
  | { success: false; error: string };

export interface AgentResponse {
  text: string | null;
  toolCallsMade: ToolCall[];
}
