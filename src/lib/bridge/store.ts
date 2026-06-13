import { turso } from '../turso-client';
import { createWorldStore } from './engine/world-store';
import { buildInitialBridgeWorld, type BridgeWorld } from './engine/tick';

// The Bridge's own world row (tick counter, crew status lines, watch state).
// Prefix 'bridge_core' keeps the generic store's tables clear of the richer
// bridge_* tables owned by src/lib/bridge/persistence (events, budget, ...).

export const bridgeStore = createWorldStore<BridgeWorld, { kind: string }>({
  client: turso,
  prefix: 'bridge_core',
  buildInitial: buildInitialBridgeWorld,
});
