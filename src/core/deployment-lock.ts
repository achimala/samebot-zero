import { Client } from "pg";
import type { Logger } from "pino";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

const SAMEBOT_DISCORD_LOCK_NAME = "samebot-zero.discord";
const LOCK_LEASE_MS = 90_000;
const LOCK_HEARTBEAT_MS = 30_000;
const LOCK_RETRY_MS = 2_000;

export class DeploymentLock {
  private client?: Client;
  private heartbeat?: NodeJS.Timeout;
  private readonly ownerId = `${hostname()}:${process.pid}:${randomUUID()}`;

  constructor(
    private readonly connectionUri: string,
    private readonly logger: Logger,
  ) {}

  async acquire() {
    const client = new Client({
      connectionString: this.normalizeConnectionUri(),
      ssl: { rejectUnauthorized: false },
    });

    client.on("error", (error) => {
      this.logger.error({ err: error }, "Samebot deployment lock connection failed");
      process.exit(1);
    });

    await client.connect();
    await this.ensureLockTable(client);
    this.logger.info({}, "Waiting for Samebot deployment lock");

    while (!(await this.tryAcquire(client))) {
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }

    this.client = client;
    this.startHeartbeat();
    this.logger.info({}, "Acquired Samebot deployment lock");
  }

  async release() {
    const client = this.client;
    if (!client) {
      return;
    }
    this.client = undefined;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    await client.query("delete from public.samebot_runtime_locks where lock_name = $1 and owner_id = $2", [
      SAMEBOT_DISCORD_LOCK_NAME,
      this.ownerId,
    ]);
    await client.end();
    this.logger.info({}, "Released Samebot deployment lock");
  }

  private async ensureLockTable(client: Client) {
    await client.query(`
      create table if not exists public.samebot_runtime_locks (
        lock_name text primary key,
        owner_id text not null,
        expires_at timestamptz not null,
        updated_at timestamptz not null default now()
      )
    `);
  }

  private async tryAcquire(client: Client) {
    const result = await client.query<{ owner_id: string }>(
      `
        insert into public.samebot_runtime_locks (lock_name, owner_id, expires_at, updated_at)
        values ($1, $2, now() + ($3::text || ' milliseconds')::interval, now())
        on conflict (lock_name) do update
        set owner_id = excluded.owner_id,
            expires_at = excluded.expires_at,
            updated_at = now()
        where samebot_runtime_locks.owner_id = excluded.owner_id
           or samebot_runtime_locks.expires_at < now()
        returning owner_id
      `,
      [SAMEBOT_DISCORD_LOCK_NAME, this.ownerId, LOCK_LEASE_MS],
    );
    return result.rowCount === 1 && result.rows[0]?.owner_id === this.ownerId;
  }

  private startHeartbeat() {
    this.heartbeat = setInterval(() => {
      void this.renew().catch((error) => {
        this.logger.error({ err: error }, "Lost Samebot deployment lock");
        process.exit(1);
      });
    }, LOCK_HEARTBEAT_MS);
  }

  private async renew() {
    const client = this.client;
    if (!client) {
      return;
    }
    const result = await client.query(
      `
        update public.samebot_runtime_locks
        set expires_at = now() + ($3::text || ' milliseconds')::interval,
            updated_at = now()
        where lock_name = $1
          and owner_id = $2
      `,
      [SAMEBOT_DISCORD_LOCK_NAME, this.ownerId, LOCK_LEASE_MS],
    );
    if (result.rowCount !== 1) {
      throw new Error("Samebot deployment lock is no longer owned by this process");
    }
  }

  private normalizeConnectionUri() {
    const url = new URL(
      this.connectionUri.replace(/^postgresql\+psycopg:\/\//, "postgresql://"),
    );
    url.searchParams.delete("sslmode");
    return url.toString();
  }
}
