import { Client } from "pg";
import type { Logger } from "pino";

const SAMEBOT_DISCORD_LOCK_ID = "1512182446766346518";

export class DeploymentLock {
  private client?: Client;

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
    this.logger.info({}, "Waiting for Samebot deployment lock");
    await client.query("select pg_advisory_lock($1::bigint)", [
      SAMEBOT_DISCORD_LOCK_ID,
    ]);
    this.client = client;
    this.logger.info({}, "Acquired Samebot deployment lock");
  }

  async release() {
    const client = this.client;
    if (!client) {
      return;
    }
    this.client = undefined;
    await client.query("select pg_advisory_unlock($1::bigint)", [
      SAMEBOT_DISCORD_LOCK_ID,
    ]);
    await client.end();
    this.logger.info({}, "Released Samebot deployment lock");
  }

  private normalizeConnectionUri() {
    const url = new URL(
      this.connectionUri.replace(/^postgresql\+psycopg:\/\//, "postgresql://"),
    );
    url.searchParams.delete("sslmode");
    return url.toString();
  }
}
