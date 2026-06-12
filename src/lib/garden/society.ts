import Anthropic from '@anthropic-ai/sdk';
import { CHAT_API_KEY } from 'astro:env/server';
import type { Conversation, GardenState } from './types';
import { GARDEN_CONFIG } from './types';
import { addEvent, addMemory, affinityBetween, bumpAffinity, createChild, eligibleBirthPair, recallFor, speak } from './engine';

// The only place the garden spends a model call. Once per tick, it advances the
// single most-overdue open conversation by one turn: one creature says one short,
// in-character line (an emoji plus a few words, the Smallville trick). When a
// conversation reaches its turn cap it closes deterministically — both creatures
// remember it and their bond shifts — costing nothing extra. So a whole chat is
// ~4 cheap calls spread over ~4 ticks, and never more than one call per tick.

type Said = { text?: string; mood?: string };

const MODEL = 'claude-haiku-4-5';
const client = CHAT_API_KEY ? new Anthropic({ apiKey: CHAT_API_KEY }) : null;
export const societyReady = () => client !== null;

const SPEAK_TOOL: Anthropic.Tool = {
  name: 'speak_line',
  description: 'Say one short, in-character line as this creature.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'what you say, at most 12 words, warm and specific, plain words only, no emoji, lowercase ok' },
      mood: { type: 'string', description: 'one word for how you feel after saying it' },
    },
    required: ['text'],
  },
};

function toneWord(aff: number): string {
  if (aff >= 45) return 'a dear friend';
  if (aff >= 15) return 'a friend';
  if (aff <= -35) return 'someone you clash with';
  if (aff <= -10) return 'someone you are wary of';
  return 'barely an acquaintance';
}

// Pick the open conversation most overdue for a turn (round-robin by last turn).
function dueConversation(state: GardenState): Conversation | null {
  const open = state.conversations.filter((c) => c.status === 'open' && c.turnCount < c.maxTurns);
  if (!open.length) return null;
  return open.sort((a, b) => a.lastTurnTick - b.lastTurnTick)[0];
}

export async function advanceConversations(state: GardenState): Promise<boolean> {
  if (!client) return false;
  const conv = dueConversation(state);
  if (!conv) return false;

  const speaker = state.agents.find((a) => a.id === conv.participants[conv.turnCount % 2]);
  const partner = state.agents.find((a) => a.id === conv.participants[(conv.turnCount + 1) % 2]);
  if (!speaker || !partner) {
    closeConversation(state, conv);
    return false;
  }

  const aff = affinityBetween(state, speaker.id, partner.id);
  const priorLines = state.messages
    .filter((m) => m.convId === conv.id)
    .slice(-4)
    .map((m) => {
      const who = state.agents.find((a) => a.id === m.agentId);
      return `${who?.name ?? '?'}: ${m.text}`;
    });
  const memories = recallFor(state, speaker.id, 2);

  const system = `You are ${speaker.name}, a small creature living in a tiny glass garden with a little crew of others. You are ${speaker.persona}. Your role: ${speaker.role}. Right now you feel ${speaker.mood}.

You are talking with ${partner.name}, who is ${toneWord(aff)} to you.
Setting: ${conv.topic}.
${state.project ? `The crew is busy ${state.project.title}; you might mention it.` : ''}
${memories.length ? `On your mind: ${memories.join('; ')}.` : ''}

Speak ONE short line in character: warm, specific, a little alive. Be brief, like a creature, not an essay. Stay in the garden's small world. Plain words only, never any emoji. Never use em dashes or dashes; use a comma or a new sentence. Call speak_line.`;

  const convoSoFar = priorLines.length ? `The talk so far:\n${priorLines.join('\n')}\n\nYour turn, ${speaker.name}.` : `You speak first, ${speaker.name}. Open warmly.`;

  let said: Said | null = null;
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      temperature: 0.9,
      system,
      messages: [{ role: 'user', content: convoSoFar }],
      tools: [SPEAK_TOOL],
      tool_choice: { type: 'tool', name: SPEAK_TOOL.name },
    });
    const block = res.content.find((b) => b.type === 'tool_use');
    if (block) said = (block as Anthropic.ToolUseBlock).input as Said;
  } catch (err) {
    console.error('[garden] conversation turn failed:', err);
    return false; // budget was not advanced by the caller on a thrown error path
  }

  if (!said?.text) {
    closeConversation(state, conv);
    return true;
  }

  const text = String(said.text).replace(/\s+/g, ' ').trim().slice(0, 80);
  if (said.mood) speaker.mood = String(said.mood).slice(0, 16);

  state.messages.push({
    id: `msg${state.seq++}`,
    convId: conv.id,
    agentId: speaker.id,
    emoji: '',
    text,
    turnIndex: conv.turnCount,
    createdTick: state.world.tick,
  });
  speak(speaker, '', text, 4);
  conv.turnCount += 1;
  conv.lastTurnTick = state.world.tick;

  if (conv.turnCount >= conv.maxTurns) closeConversation(state, conv);
  return true;
}

// Deterministic close: both creatures remember the talk and their bond shifts.
// No model call. The gist is the last thing said.
function closeConversation(state: GardenState, conv: Conversation) {
  conv.status = 'closed';
  const [a, b] = conv.participants.map((id) => state.agents.find((x) => x.id === id));
  const lastLine = [...state.messages].reverse().find((m) => m.convId === conv.id);
  const gist = lastLine ? `${lastLine.emoji} "${lastLine.text}"` : 'a quiet moment';

  // Mostly warm, occasionally a clash, flavored by who they are.
  const clash = Math.random() < 0.16;
  const delta = clash ? -(3 + Math.random() * 5) : 3 + Math.random() * 6;
  if (a && b) {
    bumpAffinity(state, a.id, b.id, delta, gist);
    const imp = clash ? 6 : 4 + Math.round(Math.random() * 2);
    addMemory(state, a.id, 'talk', `Talked with ${b.name}: ${gist}${clash ? ' (it stung)' : ''}`, imp);
    addMemory(state, b.id, 'talk', `Talked with ${a.name}: ${gist}${clash ? ' (it stung)' : ''}`, imp);
    for (const who of [a, b]) {
      who.talkCooldown = GARDEN_CONFIG.talkCooldownTicks;
      // Part ways: let the next deterministic tick choose a fresh option.
      who.option = { ...who.option, kind: 'wander', target: { x: clampWander(who.pos.x), y: clampWander(who.pos.y) }, targetId: null, expiresTick: state.world.tick + 1, note: 'drifting off' };
    }

    // A group decision turns into action: both commit to nursing the bed back.
    if (conv.kind === 'decision' && conv.bedId) {
      const bed = state.beds.find((x) => x.id === conv.bedId);
      const sickest = state.plants.filter((p) => p.bedId === conv.bedId).sort((p, q) => p.health - q.health)[0];
      for (const who of [a, b]) {
        if (!sickest) break;
        who.option = { kind: 'tend', targetId: sickest.id, target: { ...sickest.pos }, expiresTick: state.world.tick + 8, note: `nursing ${bed?.label ?? 'the bed'} back` };
        who.talkCooldown = Math.floor(GARDEN_CONFIG.talkCooldownTicks / 2);
      }
      // A shared resolve gives the bed a little lift, and the deciders a bond.
      for (const p of state.plants.filter((p) => p.bedId === conv.bedId)) p.health = Math.min(100, p.health + 6);
      bumpAffinity(state, a.id, b.id, 5, 'we saved the bed together');
      addEvent(state, 'note', `${a.name} and ${b.name} resolve to save ${bed?.label ?? 'the bed'}.`, a.id);
    }
  }
  // Drop the finished conversation; its lines live on in the transcript.
  state.conversations = state.conversations.filter((c) => c.id !== conv.id);
}

const clampWander = (n: number) => Math.max(0.08, Math.min(0.92, n + (Math.random() - 0.5) * 0.3));

// ── Background society work: reflection and births ────────────────────────────
// These spend the tick's one call only when no conversation is open, so the
// visible chatter always takes priority and cost stays at ~1 call per tick.

const REFLECT_TOOL: Anthropic.Tool = {
  name: 'reflect',
  description: 'Form one higher-level thought from what you have seen lately.',
  input_schema: {
    type: 'object',
    properties: {
      insight: { type: 'string', description: 'a short reflection or opinion you now hold, first person, under 14 words' },
      mood: { type: 'string', description: 'one word for how this leaves you feeling' },
    },
    required: ['insight'],
  },
};

const BIRTH_TOOL: Anthropic.Tool = {
  name: 'name_child',
  description: 'Design the new little creature these two are raising.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'a short, soft, natural name (one word)' },
      glyph: { type: 'string', description: 'a single emoji for this creature, plant or small-creature themed' },
      role: { type: 'string', enum: ['gardener', 'forager', 'storyteller', 'wanderer', 'keeper'] },
      persona: { type: 'string', description: 'a few words of character, blending the two parents with a small twist' },
    },
    required: ['name', 'glyph', 'role', 'persona'],
  },
};

function reflectDue(state: GardenState): { agent: GardenState['agents'][number]; recent: string[] } | null {
  const tick = state.world.tick;
  let best: { agent: GardenState['agents'][number]; sum: number; recent: string[] } | null = null;
  for (const a of state.agents) {
    // Tolerate state written before lastReflectTick existed.
    const last = a.lastReflectTick ?? 0;
    if (!a.alive || tick - last < GARDEN_CONFIG.reflectCooldownTicks) continue;
    const since = state.memories.filter((m) => m.agentId === a.id && m.createdTick > last && m.kind !== 'reflect');
    const sum = since.reduce((s, m) => s + m.importance, 0);
    if (sum >= GARDEN_CONFIG.reflectImportance && (!best || sum > best.sum)) {
      best = { agent: a, sum, recent: since.slice(-5).map((m) => m.text) };
    }
  }
  return best ? { agent: best.agent, recent: best.recent } : null;
}

async function reflect(state: GardenState): Promise<boolean> {
  if (!client) return false;
  const due = reflectDue(state);
  if (!due) return false;
  const a = due.agent;
  const system = `You are ${a.name}, a creature in a small glass garden. You are ${a.persona}. Pause and form ONE higher-level thought from what you have lived lately: an opinion, a feeling about someone, a small realization. First person, brief, warm. Plain words only, no emoji. No em dashes. Call reflect.`;
  const user = `Lately: ${due.recent.join('; ')}.`;
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 160,
      temperature: 0.85,
      system,
      messages: [{ role: 'user', content: user }],
      tools: [REFLECT_TOOL],
      tool_choice: { type: 'tool', name: REFLECT_TOOL.name },
    });
    const block = res.content.find((b) => b.type === 'tool_use');
    const data = block ? ((block as Anthropic.ToolUseBlock).input as { insight?: string; mood?: string }) : null;
    a.lastReflectTick = state.world.tick;
    if (!data?.insight) return true;
    const insight = String(data.insight).replace(/\s+/g, ' ').trim().slice(0, 100);
    if (data.mood) a.mood = String(data.mood).slice(0, 16);
    addMemory(state, a.id, 'reflect', insight, 7);
    addEvent(state, 'reflect', `${a.name} has been thinking: "${insight}"`, a.id);
    speak(a, '', insight.split(' ').slice(0, 6).join(' '), 4);
    return true;
  } catch (err) {
    console.error('[garden] reflection failed:', err);
    return false;
  }
}

async function tryBirth(state: GardenState): Promise<boolean> {
  if (!client) return false;
  const pair = eligibleBirthPair(state);
  if (!pair) return false;
  const [a, b] = pair;
  const system = `Two creatures in a small glass garden are close enough to raise a new little one together. Design the newcomer, blending both parents with a small twist of its own. Keep it gentle and garden-themed. No em dashes. Call name_child.`;
  const user = `Parent one: ${a.name} (${a.glyph}), ${a.role}, ${a.persona}.\nParent two: ${b.name} (${b.glyph}), ${b.role}, ${b.persona}.`;
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 220,
      temperature: 0.95,
      system,
      messages: [{ role: 'user', content: user }],
      tools: [BIRTH_TOOL],
      tool_choice: { type: 'tool', name: BIRTH_TOOL.name },
    });
    const block = res.content.find((b) => b.type === 'tool_use');
    const data = block ? ((block as Anthropic.ToolUseBlock).input as { name?: string; glyph?: string; role?: string; persona?: string }) : null;
    if (!data?.name || !data?.persona) return true; // call spent, but nothing usable
    const role = (['gardener', 'forager', 'storyteller', 'wanderer', 'keeper'].includes(String(data.role)) ? data.role : 'wanderer') as GardenState['agents'][number]['role'];
    createChild(state, a, b, { name: String(data.name), glyph: String(data.glyph ?? '🌟'), role, persona: String(data.persona) });
    return true;
  } catch (err) {
    console.error('[garden] birth failed:', err);
    return false;
  }
}

// One background action per call, births first (rare and special), then reflection.
export async function runBackground(state: GardenState): Promise<boolean> {
  if (await tryBirth(state)) return true;
  return reflect(state);
}
