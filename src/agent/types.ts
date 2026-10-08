export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  authorId?: string;
  author?: string;
  timestamp: number;
  /** Discord CDN URLs of attached images. */
  images?: string[];
}

export interface AgentContext {
  history: AgentMessage[];
  isDm: boolean;
  channelId: string;
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
}
