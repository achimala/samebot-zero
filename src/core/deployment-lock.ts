import { Pool } from "pg";
import type { Logger } from "pino";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

const SAMEBOT_DISCORD_LOCK_NAME = "samebot-zero.discord";
const LOCK_LEASE_MS = 90_000;
const LOCK_HEARTBEAT_MS = 15_000;
const LOCK_RETRY_MS = 2_000;

export class DeploymentLock {
  private pool: Pool | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private lastRenewedAt = 0;
  // On Render each instance has a unique hostname, so a process restarted on
  // the same instance can reclaim its own lease immediately instead of waiting
  // for it to expire. A new deploy gets a new instance and still waits.
  private readonly ownerId = process.env.RENDER
    ? hostname()
    : `${hostname()}:${process.pid}:${randomUUID()}`;

  constructor(
    private readonly connectionUri: string,
    private readonly logger: Logger,
  ) {}

  /**
   * Blocks until this process holds the lock. Resolves with whether the
   * previous holder died without releasing it (i.e. it crashed rather than
   * shutting down cleanly).
   */
  async acquire(): Promise<{ previousRunCrashed: boolean }> {
    // Use a pool rather than one long-lived connection: the Supabase pooler
    // drops idle connections, and an idle pool client erroring is harmless.
    const pool = new Pool({
      connectionString: this.normalizeConnectionUri(),
      ssl: { rejectUnauthorized: false },
      max: 1,
      idleTimeoutMillis: 10_000,
      keepAlive: true,
    });

    pool.on("error", (error) => {
      this.logger.warn({ err: error }, "Samebot deployment lock idle connection dropped");
    });

    this.pool = pool;
    await this.ensureLockTable(pool);
    this.logger.info({ ownerId: this.ownerId }, "Waiting for Samebot deployment lock");

    let result = await this.tryAcquireSafely(pool);
    while (!result.acquired) {
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      result = await this.tryAcquireSafely(pool);
    }

    this.lastRenewedAt = Date.now();
    this.startHeartbeat();
    this.logger.info(
      { previousRunCrashed: result.tookOverStaleLock },
      "Acquired Samebot deployment lock",
    );
    return { previousRunCrashed: result.tookOverStaleLock };
  }

  async release() {
    const pool = this.pool;
    if (!pool) {
      return;
    }
    this.pool = undefined;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    try {
      await pool.query("delete from public.samebot_runtime_locks where lock_name = $1 and owner_id = $2", [
        SAMEBOT_DISCORD_LOCK_NAME,
        this.ownerId,
      ]);
      this.logger.info({}, "Released Samebot deployment lock");
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to release Samebot deployment lock; it will expire");
    }
    await pool.end().catch(() => undefined);
  }

  private async ensureLockTable(pool: Pool) {
    await pool.query(`
      create table if not exists public.samebot_runtime_locks (
        lock_name text primary key,
        owner_id text not null,
        expires_at timestamptz not null,
        updated_at timestamptz not null default now()
      )
    `);
  }

  private async tryAcquireSafely(pool: Pool) {
    try {
      return await this.tryAcquire(pool);
    } catch (error) {
      this.logger.warn({ err: error }, "Samebot deployment lock acquire attempt failed; retrying");
      return { acquired: false, tookOverStaleLock: false };
    }
  }

  private async tryAcquire(pool: Pool) {
    // A clean shutdown deletes the row, so acquiring by updating an existing
    // row (`xmax <> 0`) means the previous holder died without releasing it.
    const result = await pool.query<{ owner_id: string; inserted: boolean }>(
      `
        insert into public.samebot_runtime_locks (lock_name, owner_id, expires_at, updated_at)
        values ($1, $2, now() + ($3::text || ' milliseconds')::interval, now())
        on conflict (lock_name) do update
        set owner_id = excluded.owner_id,
            expires_at = excluded.expires_at,
            updated_at = now()
        where samebot_runtime_locks.owner_id = excluded.owner_id
           or samebot_runtime_locks.expires_at < now()
        returning owner_id, (xmax = 0) as inserted
      `,
      [SAMEBOT_DISCORD_LOCK_NAME, this.ownerId, LOCK_LEASE_MS],
    );
    const row = result.rows[0];
    const acquired = result.rowCount === 1 && row?.owner_id === this.ownerId;
    return { acquired, tookOverStaleLock: acquired && row?.inserted === false };
  }

  private startHeartbeat() {
    this.heartbeat = setInterval(() => {
      void this.renew();
    }, LOCK_HEARTBEAT_MS);
  }

  private async renew() {
    const pool = this.pool;
    if (!pool) {
      return;
    }
    let rowCount: number | null;
    try {
      const result = await pool.query(
        `
          update public.samebot_runtime_locks
          set expires_at = now() + ($3::text || ' milliseconds')::interval,
              updated_at = now()
          where lock_name = $1
            and owner_id = $2
        `,
        [SAMEBOT_DISCORD_LOCK_NAME, this.ownerId, LOCK_LEASE_MS],
      );
      rowCount = result.rowCount;
    } catch (error) {
      // Transient DB/network failure: keep running as long as our lease could
      // still be valid. Only give up once it has definitely expired.
      const sinceRenewedMs = Date.now() - this.lastRenewedAt;
      if (sinceRenewedMs < LOCK_LEASE_MS - LOCK_HEARTBEAT_MS) {
        this.logger.warn({ err: error, sinceRenewedMs }, "Failed to renew Samebot deployment lock; will retry");
        return;
      }
      this.logger.error({ err: error, sinceRenewedMs }, "Lost Samebot deployment lock");
      process.exit(1);
    }
    if (rowCount !== 1) {
      this.logger.error({}, "Samebot deployment lock is no longer owned by this process");
      process.exit(1);
    }
    this.lastRenewedAt = Date.now();
  }

  private normalizeConnectionUri() {
    const url = new URL(
      this.connectionUri.replace(/^postgresql\+psycopg:\/\//, "postgresql://"),
    );
    url.searchParams.delete("sslmode");
    return url.toString();
  }
}
