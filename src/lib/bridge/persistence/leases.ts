import type { Client } from '@libsql/client';
import { ensureBridgeSchema } from './schema';

// Named lease locks. Acquisition is a single compare-and-set UPDATE so exactly
// one caller wins while the lease is free or expired, no matter how many
// concurrent instances race. TTL must exceed the worst-case holder duration;
// long holders renew. Visitor-triggered ticks lose the race harmlessly.

export async function acquireLease(
  client: Client,
  name: string,
  holder: string,
  ttlMs: number,
  nowMs = Date.now(),
): Promise<boolean> {
  await ensureBridgeSchema(client);
  await client.execute({
    sql: `INSERT OR IGNORE INTO bridge_leases (name, holder, lease_until) VALUES (?, '', 0)`,
    args: [name],
  });
  const rs = await client.execute({
    sql: `UPDATE bridge_leases SET holder = ?, lease_until = ? WHERE name = ? AND lease_until < ?`,
    args: [holder, nowMs + ttlMs, name, nowMs],
  });
  return rs.rowsAffected === 1;
}

/** Extend a lease you hold. Returns false if it was lost (expired and taken). */
export async function renewLease(
  client: Client,
  name: string,
  holder: string,
  ttlMs: number,
  nowMs = Date.now(),
): Promise<boolean> {
  const rs = await client.execute({
    sql: `UPDATE bridge_leases SET lease_until = ? WHERE name = ? AND holder = ?`,
    args: [nowMs + ttlMs, name, holder],
  });
  return rs.rowsAffected === 1;
}

/** Release only if still held by this holder, so a slow holder can't stomp a successor. */
export async function releaseLease(client: Client, name: string, holder: string): Promise<void> {
  await client.execute({
    sql: `UPDATE bridge_leases SET holder = '', lease_until = 0 WHERE name = ? AND holder = ?`,
    args: [name, holder],
  });
}
