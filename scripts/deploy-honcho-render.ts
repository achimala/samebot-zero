import "@total-typescript/ts-reset";
import { createHmac, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const DEFAULT_RENDER_ENVIRONMENT_ID = "evm-d4gk1v7diees73av676g";
const SAMEBOT_SERVICE_ID = "srv-d4gk1v95pdvs738l9160";

const EnvSchema = z.object({
  SUPABASE_DB_CONNECTION_URI: z
    .string()
    .startsWith("postgresql+psycopg://"),
  RENDER_API_KEY: z.string().optional(),
  RENDER_ENVIRONMENT_ID: z.string().default(DEFAULT_RENDER_ENVIRONMENT_ID),
  RENDER_REGION: z.string().default("oregon"),
  RENDER_PLAN: z.string().default("starter"),
  HONCHO_REPO: z.string().default("https://github.com/plastic-labs/honcho"),
  HONCHO_BRANCH: z.string().default("main"),
  HONCHO_API_SERVICE_NAME: z.string().default("samebot-honcho-api"),
  HONCHO_DERIVER_SERVICE_NAME: z.string().default("samebot-honcho-deriver"),
  HONCHO_WORKSPACE_ID: z.string().default("samebot-zero"),
  HONCHO_ASSISTANT_PEER_ID: z.string().default("samebot"),
  HONCHO_AUTH_JWT_SECRET: z.string().optional(),
  HONCHO_INTERNAL_URL: z.string().url().optional(),
  LLM_OPENAI_API_KEY: z.string().optional(),
  SKIP_DEPLOYS: z.string().optional(),
  SKIP_LEGACY_IMPORT_JOB: z.string().optional(),
});

interface RenderService {
  id: string;
  name: string;
  slug: string;
  type: string;
}

interface RenderServiceListItem {
  service: RenderService;
}

type EnvMap = Map<string, string>;

const env = EnvSchema.parse(process.env);
const renderApiKey = env.RENDER_API_KEY ?? readRenderApiKey();

const samebotEnv = await getServiceEnv(SAMEBOT_SERVICE_ID);
const openAIApiKey = env.LLM_OPENAI_API_KEY ?? samebotEnv.get("OPENAI_API_KEY");
if (!openAIApiKey) {
  throw new Error("OPENAI_API_KEY is not available from Render or LLM_OPENAI_API_KEY.");
}

const existingApiEnv = await getServiceEnvByName(env.HONCHO_API_SERVICE_NAME);
const authJwtSecret =
  env.HONCHO_AUTH_JWT_SECRET ??
  existingApiEnv?.get("AUTH_JWT_SECRET") ??
  randomBytes(32).toString("hex");
const honchoApiKey = createWorkspaceJwt(authJwtSecret, env.HONCHO_WORKSPACE_ID);

runPsql(
  env.SUPABASE_DB_CONNECTION_URI,
  "create extension if not exists vector; create schema if not exists honcho;",
);

const honchoEnv = new Map<string, string>([
  ["LOG_LEVEL", "INFO"],
  ["NAMESPACE", "honcho"],
  ["DB_CONNECTION_URI", env.SUPABASE_DB_CONNECTION_URI],
  ["DB_SCHEMA", "honcho"],
  ["DB_POOL_SIZE", "5"],
  ["DB_MAX_OVERFLOW", "5"],
  ["AUTH_USE_AUTH", "true"],
  ["AUTH_JWT_SECRET", authJwtSecret],
  ["LLM_OPENAI_API_KEY", openAIApiKey],
  ["CACHE_ENABLED", "false"],
  ["VECTOR_STORE_TYPE", "pgvector"],
  ["VECTOR_STORE_MIGRATED", "false"],
]);

const apiService = await ensureRenderService({
  name: env.HONCHO_API_SERVICE_NAME,
  type: "private_service",
  startCommand: "sh docker/entrypoint.sh",
  envVars: honchoEnv,
});
await putServiceEnv(apiService.id, honchoEnv);

const deriverService = await ensureRenderService({
  name: env.HONCHO_DERIVER_SERVICE_NAME,
  type: "background_worker",
  startCommand: "/app/.venv/bin/python -m src.deriver",
  envVars: honchoEnv,
});
await putServiceEnv(deriverService.id, honchoEnv);

const honchoUrl =
  env.HONCHO_INTERNAL_URL ?? `http://${apiService.slug}:8000`;
samebotEnv.set("HONCHO_URL", honchoUrl);
samebotEnv.set("HONCHO_API_KEY", honchoApiKey);
samebotEnv.set("HONCHO_WORKSPACE_ID", env.HONCHO_WORKSPACE_ID);
samebotEnv.set("HONCHO_ASSISTANT_PEER_ID", env.HONCHO_ASSISTANT_PEER_ID);
samebotEnv.set("SUPABASE_DB_CONNECTION_URI", env.SUPABASE_DB_CONNECTION_URI);
await putServiceEnv(SAMEBOT_SERVICE_ID, samebotEnv);

if (env.SKIP_DEPLOYS !== "1") {
  deployService(apiService.id);
  deployService(deriverService.id);
  deployService(SAMEBOT_SERVICE_ID, currentGitCommit());
}

if (env.SKIP_LEGACY_IMPORT_JOB !== "1") {
  run("render", [
    "jobs",
    "create",
    SAMEBOT_SERVICE_ID,
    "--start-command",
    "pnpm migrate:honcho-memory",
    "--confirm",
    "--output",
    "json",
  ]);
}

console.log(
  [
    `Honcho API service: ${apiService.id} (${apiService.slug})`,
    `Honcho deriver service: ${deriverService.id} (${deriverService.slug})`,
    `Samebot HONCHO_URL: ${honchoUrl}`,
  ].join("\n"),
);

async function ensureRenderService(options: {
  name: string;
  type: "private_service" | "background_worker";
  startCommand: string;
  healthCheckPath?: string;
  envVars: EnvMap;
}): Promise<RenderService> {
  const existing = getRenderServiceByName(options.name);
  if (existing) {
    const updateArgs = [
      "services",
      "update",
      existing.id,
      "--repo",
      env.HONCHO_REPO,
      "--branch",
      env.HONCHO_BRANCH,
      "--runtime",
      "docker",
      "--start-command",
      options.startCommand,
      "--plan",
      env.RENDER_PLAN,
      "--confirm",
      "--output",
      "json",
    ];
    if (options.healthCheckPath && options.type !== "private_service") {
      updateArgs.push("--health-check-path", options.healthCheckPath);
    }
    run("render", updateArgs);
    return getRenderServiceByName(options.name) ?? existing;
  }

  const createArgs = [
    "services",
    "create",
    "--name",
    options.name,
    "--type",
    options.type,
    "--repo",
    env.HONCHO_REPO,
    "--branch",
    env.HONCHO_BRANCH,
    "--runtime",
    "docker",
    "--environment-id",
    env.RENDER_ENVIRONMENT_ID,
    "--region",
    env.RENDER_REGION,
    "--plan",
    env.RENDER_PLAN,
    "--start-command",
    options.startCommand,
    "--confirm",
    "--output",
    "json",
  ];
  if (options.healthCheckPath && options.type !== "private_service") {
    createArgs.push("--health-check-path", options.healthCheckPath);
  }
  for (const [key, value] of options.envVars.entries()) {
    createArgs.push("--env-var", `${key}=${value}`);
  }

  run("render", createArgs);
  const service = getRenderServiceByName(options.name);
  if (!service) {
    throw new Error(`Render service ${options.name} was not created.`);
  }
  return service;
}

function getRenderServiceByName(name: string): RenderService | undefined {
  const services = JSON.parse(
    run("render", ["services", "--output", "json"]),
  ) as RenderServiceListItem[];
  return services.find((item) => item.service.name === name)?.service;
}

async function getServiceEnvByName(name: string): Promise<EnvMap | undefined> {
  const service = getRenderServiceByName(name);
  if (!service) {
    return undefined;
  }
  return getServiceEnv(service.id);
}

async function getServiceEnv(serviceId: string): Promise<EnvMap> {
  const data = (await renderApi(
    `/services/${serviceId}/env-vars`,
  )) as Array<{ envVar?: { key: string; value: string }; key?: string; value?: string }>;

  const map = new Map<string, string>();
  for (const item of data) {
    const envVar = item.envVar ?? item;
    if (envVar.key && envVar.value !== undefined) {
      map.set(envVar.key, envVar.value);
    }
  }
  return map;
}

async function putServiceEnv(serviceId: string, vars: EnvMap): Promise<void> {
  await renderApi(`/services/${serviceId}/env-vars`, {
    method: "PUT",
    body: JSON.stringify(
      Array.from(vars.entries()).map(([key, value]) => ({ key, value })),
    ),
  });
}

function deployService(serviceId: string, commit?: string): void {
  const args = ["deploys", "create", serviceId, "--wait", "--confirm"];
  if (commit) {
    args.push("--commit", commit);
  }
  run("render", args);
}

async function renderApi(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`https://api.render.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${renderApiKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(
      `Render API ${path} failed: ${response.status} ${await response.text()}`,
    );
  }
  const text = await response.text();
  if (!text) {
    return null;
  }
  return JSON.parse(text) as unknown;
}

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const output = scrubCommandOutput(`${result.stdout}${result.stderr}`);
    if (output.trim().length > 0) {
      process.stderr.write(output);
    }
    throw new Error(`${command} failed with exit code ${result.status ?? "unknown"}`);
  }
  return result.stdout;
}

function runPsql(connectionUri: string, sql: string): void {
  const psqlUri = connectionUri.replace(
    "postgresql+psycopg://",
    "postgresql://",
  );
  execFileSync("psql", [psqlUri, "-v", "ON_ERROR_STOP=1", "-c", sql], {
    stdio: "inherit",
  });
}

function readRenderApiKey(): string {
  const configPath = join(homedir(), ".render", "cli.yaml");
  if (!existsSync(configPath)) {
    throw new Error("RENDER_API_KEY is not set and ~/.render/cli.yaml is missing.");
  }
  const config = readFileSync(configPath, "utf8");
  const keyLine = config
    .split("\n")
    .find((line) => line.startsWith("    key:"));
  const key = keyLine?.split(":", 2)[1]?.trim();
  if (!key) {
    throw new Error("Could not read Render API key from ~/.render/cli.yaml.");
  }
  return key;
}

function currentGitCommit(): string {
  return run("git", ["rev-parse", "HEAD"]).trim();
}

function createWorkspaceJwt(secret: string, workspaceId: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { t: new Date().toISOString(), w: workspaceId };
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function scrubCommandOutput(output: string): string {
  return output
    .replace(/(--env-var\s+[^=\s]+=)(\S+)/g, "$1***")
    .replace(/postgresql(?:\+psycopg)?:\/\/\S+/g, "postgresql://***")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***");
}
