import type { Client } from '@libsql/client';
import type { BridgeWorld } from '../engine/tick';
import type { BridgeEventInput } from './events';
import { eventInsert } from './events';
import { ensureBridgeSchema } from './schema';

const BRIDGE_STATE_TABLE = 'bridge_core_state';

/** Commit the world CAS and its receipts as one database transaction. */
export async function commitBridgeTick(
  client: Client,
  input: {
    world: BridgeWorld;
    expectedVersion: number;
    lockToken: number;
    tickedAtIso: string;
    events: BridgeEventInput[];
  },
): Promise<boolean> {
  await ensureBridgeSchema(client);
  const tx = await client.transaction('write');
  try {
    const committedAt = new Date().toISOString();
    const state = await tx.execute({
      sql: `UPDATE ${BRIDGE_STATE_TABLE}
            SET version = version + 1, world = ?, ticked_at = ?, lock_until = 0, updated_at = ?
            WHERE id = 1 AND version = ? AND lock_until = ? AND lock_until >= ?`,
      args: [
        JSON.stringify(input.world),
        input.tickedAtIso,
        committedAt,
        input.expectedVersion,
        input.lockToken,
        Date.now(),
      ],
    });
    if (state.rowsAffected !== 1) return false;
    if (input.events.length) {
      await tx.batch(input.events.map((event) => eventInsert(event, input.tickedAtIso)));
    }
    await tx.commit();
    return true;
  } finally {
    tx.close();
  }
}
