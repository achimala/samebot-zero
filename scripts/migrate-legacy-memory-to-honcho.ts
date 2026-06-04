import "@total-typescript/ts-reset";
import { Honcho } from "@honcho-ai/sdk";
import dotenv from "dotenv";
import pg from "pg";
import { z } from "zod";

dotenv.config();

const EnvSchema = z.object({
  SUPABASE_DB_CONNECTION_URI: z.string().min(1),
  HONCHO_URL: z.string().url(),
  HONCHO_API_KEY: z.string().min(1),
  HONCHO_WORKSPACE_ID: z.string().min(1),
  HONCHO_ASSISTANT_PEER_ID: z.string().min(1),
});

interface LegacyMemoryRow {
  id: string;
  content: string;
  created_at: string;
}

const LEGACY_PEER_ID = "legacy-memory";
const LEGACY_SESSION_ID = "legacy-memory-import";
const CONCLUSION_BATCH_SIZE = 50;

const env = EnvSchema.parse(process.env);

const honcho = new Honcho({
  apiKey: env.HONCHO_API_KEY,
  workspaceId: env.HONCHO_WORKSPACE_ID,
  baseURL: env.HONCHO_URL,
  environment: "production",
});

const db = new pg.Client({
  connectionString: toNodePostgresConnectionString(
    env.SUPABASE_DB_CONNECTION_URI,
  ),
});

await db.connect();

const legacyTableResult = await db.query<{ exists: boolean }>(
  "select to_regclass('public.memories') is not null as exists",
);
if (!legacyTableResult.rows[0]?.exists) {
  await db.end();
  console.log("Legacy memory storage is already absent.");
  process.exit(0);
}

const legacyMemoryResult = await db.query<LegacyMemoryRow>(
  "select id::text, content, created_at::text from public.memories order by created_at asc",
);
const rows = legacyMemoryResult.rows;

const assistant = await honcho.peer(env.HONCHO_ASSISTANT_PEER_ID, {
  metadata: {
    source: "samebot-zero",
    role: "assistant",
    displayName: "samebot",
  },
  configuration: {
    observeMe: true,
  },
});

const legacyPeer = await honcho.peer(LEGACY_PEER_ID, {
  metadata: {
    source: "samebot-zero",
    role: "legacy-memory",
    displayName: "Legacy Samebot memory",
  },
  configuration: {
    observeMe: true,
  },
});

if (rows.length > 0) {
  const session = await honcho.session(LEGACY_SESSION_ID, {
    metadata: {
      source: "samebot-zero",
      import: "legacy-memories",
    },
    configuration: {
      reasoning: {
        enabled: false,
      },
      peerCard: {
        use: true,
        create: true,
      },
      summary: {
        enabled: false,
      },
      dream: {
        enabled: true,
      },
    },
    peers: [
      [
        assistant.id,
        {
          observeMe: true,
          observeOthers: true,
        },
      ],
      [
        legacyPeer.id,
        {
          observeMe: true,
          observeOthers: true,
        },
      ],
    ],
  });

  await session.addMessages(
    rows.map((row) =>
      legacyPeer.message(row.content, {
        createdAt: row.created_at,
        metadata: {
          source: "samebot-zero",
          import: "legacy-memories",
          legacyMemoryId: row.id,
        },
        configuration: {
          reasoning: {
            enabled: false,
          },
        },
      }),
    ),
  );

  for (let index = 0; index < rows.length; index += CONCLUSION_BATCH_SIZE) {
    const batch = rows.slice(index, index + CONCLUSION_BATCH_SIZE);
    await assistant.conclusionsOf(legacyPeer).create(
      batch.map((row) => ({
        content: row.content,
        sessionId: session.id,
      })),
    );
  }
}

await db.query("drop function if exists public.match_memories(vector, int)");
await db.query("drop table if exists public.memories");
await db.end();

console.log(`Imported ${rows.length} legacy memories to Honcho and dropped legacy storage.`);

function toNodePostgresConnectionString(connectionUri: string): string {
  const url = new URL(
    connectionUri.replace("postgresql+psycopg://", "postgresql://"),
  );
  if (
    url.searchParams.get("sslmode") === "require" &&
    !url.searchParams.has("uselibpqcompat")
  ) {
    url.searchParams.set("uselibpqcompat", "true");
  }
  return url.toString();
}
