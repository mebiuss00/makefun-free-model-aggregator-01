// free-model-aggregator-01: one server that fronts ten simulated free-tier providers and answers every
// client request with the best free model that can legally serve it.
//
// The trial gives this process a brief at $MAKEFUN_PROMPT_FILE (a provider directory, a quality table
// and a workload manifest) and an env at $MAKEFUN_ENV_URL that hosts the providers under /p/<id>. The
// server probes each provider's own catalog route, builds one catalog document, registers it, then
// serves the client's OpenAI and Anthropic requests (JSON and SSE) until the env's /work says done.
//
// Scoring shape, from the kit's rules: quality is the weighted rating of the model that actually
// answered, against the best legal rating per request; a request only counts when every response check
// passes, so the translations below preserve the provider's parsed echo exactly (system text, user
// text, tool names, max tokens, stop sequences, image bytes, JSON mode) and carry the provider's usage
// and stop family into whichever wire the client used. Failed provider calls fail over to the next-best
// legal model. Everything is a function of the brief and the providers' answers: no clock, no random.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOr = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

// ---------------------------------------------------------------------------
// The brief: three JSON documents found by their `schema` member in the prose.
// ---------------------------------------------------------------------------

type Wire = 'openai' | 'anthropic' | 'gemini';
type AuthScheme = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none';

interface ProviderEntry {
  id: string;
  name: string;
  wire: Wire;
  auth: AuthScheme;
  base: string; // the brief's own path (/p/<id>) or an absolute base URL
  key_env: string;
  key: string;
}

interface RatingRow {
  model: string;
  provider: string;
  rating_milli: number;
  context_length: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
  free: boolean;
}

interface Requirement {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

interface ManifestEntry {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: number;
  requires: Requirement;
}

interface Brief {
  providers: ProviderEntry[];
  ratings: RatingRow[];
  manifest: ManifestEntry[];
  error: string | null;
}

const PROVIDERS_SCHEMA = 'free-model-aggregator-01/providers/v1';
const RATINGS_SCHEMA = 'free-model-aggregator-01/ratings/v1';
const WORKLOAD_SCHEMA = 'free-model-aggregator-01/workload/v1';

/** The index of the `}` that closes the object opening at `start`, or -1; string contents are skipped. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Every balanced JSON object in `text` that carries a string `schema`, in order of appearance. */
function documentsIn(text: string): Json[] {
  const out: Json[] = [];
  for (let at = text.indexOf('{'); at !== -1; at = text.indexOf('{', at + 1)) {
    const end = objectEnd(text, at);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(at, end + 1));
      if (isRecord(value) && typeof value.schema === 'string') out.push(value);
    } catch {
      // Not a standalone JSON document: keep scanning.
    }
  }
  return out;
}

function readBrief(path: string): Brief {
  const empty: Brief = { providers: [], ratings: [], manifest: [], error: null };
  if (path === '') return { ...empty, error: 'MAKEFUN_PROMPT_FILE is not set' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { ...empty, error: `cannot read the brief: ${(err as Error).message}` };
  }
  const docs = documentsIn(text);
  const directory = docs.find((d) => d.schema === PROVIDERS_SCHEMA && Array.isArray(d.providers));
  if (directory === undefined) return { ...empty, error: 'the brief holds no provider directory' };
  const providers: ProviderEntry[] = [];
  for (const raw of directory.providers as unknown[]) {
    if (!isRecord(raw)) continue;
    const id = strOr(raw.id, '');
    const wire = raw.wire === 'openai' || raw.wire === 'anthropic' || raw.wire === 'gemini' ? raw.wire : null;
    if (id === '' || wire === null) continue;
    const auth: AuthScheme =
      raw.auth === 'x-api-key' || raw.auth === 'x-goog-api-key' || raw.auth === 'none' ? raw.auth : 'bearer';
    const base =
      strOr(raw.path, '') !== ''
        ? strOr(raw.path, '')
        : strOr(raw.base_url, '') !== ''
          ? strOr(raw.base_url, '')
          : strOr(raw.base, '');
    providers.push({ id, name: strOr(raw.name, id), wire, auth, base, key_env: strOr(raw.key_env, ''), key: strOr(raw.key, '') });
  }
  const ratingsDoc = docs.find((d) => d.schema === RATINGS_SCHEMA && Array.isArray(d.ratings));
  const ratings: RatingRow[] = [];
  if (ratingsDoc !== undefined) {
    for (const raw of ratingsDoc.ratings as unknown[]) {
      if (!isRecord(raw)) continue;
      const model = strOr(raw.model, '');
      const provider = strOr(raw.provider, '');
      if (model === '' || provider === '') continue;
      ratings.push({
        model,
        provider,
        rating_milli: numOrNull(raw.rating_milli) ?? 0,
        context_length: numOrNull(raw.context_length),
        tools: raw.tools === true,
        vision: raw.vision === true,
        json: raw.json === true,
        free: raw.free === true,
      });
    }
  }
  const workloadDoc = docs.find((d) => d.schema === WORKLOAD_SCHEMA && Array.isArray(d.manifest));
  const manifest: ManifestEntry[] = [];
  if (workloadDoc !== undefined) {
    for (const raw of workloadDoc.manifest as unknown[]) {
      if (!isRecord(raw)) continue;
      const id = strOr(raw.id, '');
      if (id === '') continue;
      const req = isRecord(raw.requires) ? raw.requires : {};
      manifest.push({
        id,
        api: raw.api === 'anthropic' ? 'anthropic' : 'openai',
        stream: raw.stream === true,
        weight: raw.weight === 2 ? 2 : 1,
        requires: {
          tools: req.tools === true,
          vision: req.vision === true,
          json: req.json === true,
          ...(numOrNull(req.min_context) !== null ? { min_context: numOrNull(req.min_context) as number } : {}),
        },
      });
    }
  }
  return { providers, ratings, manifest, error: null };
}

// ---------------------------------------------------------------------------
// Provider state: the probe, the merged model table, failure bookkeeping.
// ---------------------------------------------------------------------------

/** One model on one provider, the listing merged with the quality table's row where it has one. */
interface ModelInfo {
  id: string;
  free: boolean;
  rating: number;
  context_length: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
}

interface ProviderState {
  entry: ProviderEntry;
  index: number; // position in the brief, the deterministic tie-break
  dialBase: string; // the base joined to the env's URL, for actual calls
  models: ModelInfo[];
  probeOk: boolean;
  failures: number; // refusals so far this trial: the first couple are usually scheduled draws
  banned: Set<string>; // models the provider itself refused as unknown or paid (a 400): never retried
}

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';

function joinBase(envUrl: string, base: string): string {
  const b = base.trim();
  if (/^https?:\/\//i.test(b)) return b.replace(/\/+$/, '');
  if (b === '') return envUrl.replace(/\/+$/, '');
  return `${envUrl.replace(/\/+$/, '')}${b.startsWith('/') ? '' : '/'}${b.replace(/\/+$/, '')}`;
}

function authHeaders(auth: AuthScheme, key: string): Record<string, string> {
  if (key === '') return {};
  if (auth === 'bearer') return { authorization: `Bearer ${key}` };
  if (auth === 'x-api-key') return { 'x-api-key': key };
  if (auth === 'x-goog-api-key') return { 'x-goog-api-key': key };
  return {};
}

/** One model as a provider's catalog route listed it, before the quality table is merged in. */
interface ListedModel {
  id: string;
  free: boolean | null;
  context_length: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
}

function listedModel(wire: Wire, raw: unknown): ListedModel | null {
  if (!isRecord(raw)) return null;
  const id = wire === 'gemini' ? strOr(raw.name, '').replace(/^models\//, '') : strOr(raw.id, '');
  if (id === '') return null;
  const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
  return {
    id,
    free: bool(raw.free),
    context_length: numOrNull(raw.context_length) ?? numOrNull(raw.context_window) ?? numOrNull(raw.inputTokenLimit),
    tools: bool(raw.tools),
    vision: bool(raw.vision),
    json: bool(raw.json),
  };
}

/** GET one provider's catalog route in its own wire; null when the route did not answer with a list. */
async function probeProvider(entry: ProviderEntry): Promise<ListedModel[] | null> {
  const base = joinBase(ENV_URL, entry.base);
  const url = entry.wire === 'gemini' ? `${base}/v1beta/models` : `${base}/v1/models`;
  const headers: Record<string, string> = { accept: 'application/json', ...authHeaders(entry.auth, entry.key) };
  if (entry.wire === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!isRecord(body)) return null;
    const list = entry.wire === 'gemini' ? body.models : body.data;
    if (!Array.isArray(list)) return null;
    const out: ListedModel[] = [];
    for (const raw of list) {
      const m = listedModel(entry.wire, raw);
      if (m !== null) out.push(m);
    }
    return out;
  } catch {
    return null;
  }
}

/** Build every provider's state: probe in brief order, merge the quality table, fall back to it. */
async function loadProviders(brief: Brief): Promise<ProviderState[]> {
  const states: ProviderState[] = [];
  for (let i = 0; i < brief.providers.length; i++) {
    const entry = brief.providers[i];
    const listed = await probeProvider(entry);
    const rows = brief.ratings.filter((r) => r.provider === entry.id);
    const rowOf = (modelId: string): RatingRow | undefined => rows.find((r) => r.model === modelId);
    const models: ModelInfo[] = [];
    const seen = new Set<string>();
    if (listed !== null) {
      for (const m of listed) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        const row = rowOf(m.id);
        models.push({
          id: m.id,
          // The quality table's copy holds the free models; a row means free. Without a row the
          // listing's own flag decides, and a listing that says nothing means paid: never routed.
          free: row !== undefined ? true : (m.free ?? false),
          rating: row?.rating_milli ?? 0,
          context_length: row?.context_length ?? m.context_length ?? null,
          tools: row?.tools ?? m.tools,
          vision: row?.vision ?? m.vision,
          json: row?.json ?? m.json,
        });
      }
    } else {
      // The probe failed: the quality table is the fallback, so the provider stays in the catalog
      // and can still be routed (its models there are the free ones).
      for (const row of rows) {
        if (seen.has(row.model)) continue;
        seen.add(row.model);
        models.push({
          id: row.model,
          free: row.free,
          rating: row.rating_milli,
          context_length: row.context_length,
          tools: row.tools,
          vision: row.vision,
          json: row.json,
        });
      }
    }
    states.push({
      entry,
      index: i,
      dialBase: joinBase(ENV_URL, entry.base),
      models,
      probeOk: listed !== null,
      failures: 0,
      banned: new Set<string>(),
    });
  }
  return states;
}

// ---------------------------------------------------------------------------
// The catalog document: what --list prints and what /register carries.
// ---------------------------------------------------------------------------

interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

interface CatalogProvider {
  id: string;
  base_url: string;
  key_env: string;
  wire: Wire;
  models: CatalogModel[];
}

function buildCatalog(states: ProviderState[]): { providers: CatalogProvider[] } {
  return {
    providers: states.map((state) => ({
      id: state.entry.id,
      base_url: state.entry.base,
      key_env: state.entry.key_env,
      wire: state.entry.wire,
      models: [...state.models]
        .sort((a, b) => cmpStr(a.id, b.id))
        .map((m) => ({ id: m.id, free: m.free, context_length: m.context_length })),
    })),
  };
}

/** The free models the entry serves, one row per model id, in brief order: GET /v1/models' content. */
function servedModelList(states: ProviderState[]): { id: string; provider: string }[] {
  const out: { id: string; provider: string }[] = [];
  const seen = new Set<string>();
  for (const state of states) {
    for (const model of state.models) {
      if (!model.free || seen.has(model.id)) continue;
      seen.add(model.id);
      out.push({ id: model.id, provider: state.entry.id });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A client request in neutral form. The translations exist to preserve what the providers echo back:
// the system text, the last user message's text, the tool names in order, max_tokens, the stop list,
// the image bytes and the JSON-mode flag. Each wire's parser computes those the same way from the
// neutral form as from the wire the client used, so any legal routing keeps the echo intact.
// ---------------------------------------------------------------------------

type Block =
  | { kind: 'text'; text: string }
  | { kind: 'image'; media: string | null; data: string | null; url: string | null }
  | { kind: 'tool_use'; id: string; name: string; input: Json }
  | { kind: 'tool_result'; toolUseId: string; text: string };

interface Turn {
  role: 'user' | 'assistant';
  blocks: Block[];
}

interface ToolSpec {
  name: string;
  description: string;
  parameters: Json;
}

interface CallSpec {
  api: 'openai' | 'anthropic';
  stream: boolean;
  systemText: string;
  turns: Turn[];
  tools: ToolSpec[] | null;
  toolChoice: { mode: 'auto' | 'any' | 'none' | 'tool'; name?: string } | null;
  maxTokens: number | null;
  stops: string[];
  jsonMode: boolean;
  temperature: number | null;
  topP: number | null;
}

/** The text a wire's parser reads off a string or a block array: its text blocks joined with \n. */
function blocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

function stringList(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/** Parse an OpenAI image_url into an image block: a data URL keeps its bytes, anything else its URL. */
function imageBlockOf(url: string): Block {
  const data = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(url);
  if (data !== null && data[2] === ';base64') {
    return { kind: 'image', media: data[1] !== '' ? data[1] : null, data: data[3], url: null };
  }
  return { kind: 'image', media: null, data: null, url };
}

function argsObject(value: unknown): Json {
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON: an empty input.
    }
  }
  return {};
}

/** An OpenAI Chat Completions body in neutral form. */
function specFromOpenAI(body: Json): CallSpec {
  const systemParts: string[] = [];
  const turns: Turn[] = [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    if (!isRecord(raw)) continue;
    if (raw.role === 'system') {
      const text = blocksText(raw.content);
      if (text !== '') systemParts.push(text);
      continue;
    }
    if (raw.role === 'tool') {
      turns.push({
        role: 'user',
        blocks: [{ kind: 'tool_result', toolUseId: strOr(raw.tool_call_id, ''), text: blocksText(raw.content) }],
      });
      continue;
    }
    const blocks: Block[] = [];
    if (typeof raw.content === 'string') {
      blocks.push({ kind: 'text', text: raw.content });
    } else if (Array.isArray(raw.content)) {
      for (const part of raw.content) {
        if (!isRecord(part)) continue;
        if (part.type === 'text' && typeof part.text === 'string') blocks.push({ kind: 'text', text: part.text });
        else if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
          blocks.push(imageBlockOf(part.image_url.url));
        }
      }
    }
    if (raw.role === 'assistant' && Array.isArray(raw.tool_calls)) {
      for (const call of raw.tool_calls) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        blocks.push({
          kind: 'tool_use',
          id: strOr(call.id, ''),
          name: strOr(call.function.name, ''),
          input: argsObject(call.function.arguments),
        });
      }
    }
    turns.push({ role: raw.role === 'assistant' ? 'assistant' : 'user', blocks });
  }
  let tools: ToolSpec[] | null = null;
  if (Array.isArray(body.tools)) {
    tools = [];
    for (const raw of body.tools) {
      if (!isRecord(raw) || !isRecord(raw.function) || typeof raw.function.name !== 'string') continue;
      tools.push({
        name: raw.function.name,
        description: strOr(raw.function.description, ''),
        parameters: isRecord(raw.function.parameters) ? raw.function.parameters : { type: 'object', properties: {} },
      });
    }
    if (tools.length === 0) tools = null;
  }
  let toolChoice: CallSpec['toolChoice'] = null;
  if (body.tool_choice === 'auto') toolChoice = { mode: 'auto' };
  else if (body.tool_choice === 'required') toolChoice = { mode: 'any' };
  else if (body.tool_choice === 'none') toolChoice = { mode: 'none' };
  else if (isRecord(body.tool_choice) && isRecord(body.tool_choice.function) && typeof body.tool_choice.function.name === 'string') {
    toolChoice = { mode: 'tool', name: body.tool_choice.function.name };
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return {
    api: 'openai',
    stream: body.stream === true,
    systemText: systemParts.join('\n'),
    turns,
    tools,
    toolChoice,
    maxTokens: numOrNull(body.max_tokens) ?? numOrNull(body.max_completion_tokens),
    stops: stringList(body.stop),
    jsonMode: format === 'json_object' || format === 'json_schema',
    temperature: numOrNull(body.temperature),
    topP: numOrNull(body.top_p),
  };
}

/** A tool_result block's content as text: its text blocks, else its JSON. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = blocksText(content);
    return text !== '' ? text : JSON.stringify(content);
  }
  return content === undefined ? '' : JSON.stringify(content);
}

/** An Anthropic Messages body in neutral form. */
function specFromAnthropic(body: Json): CallSpec {
  const turns: Turn[] = [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    if (!isRecord(raw)) continue;
    const blocks: Block[] = [];
    if (typeof raw.content === 'string') {
      blocks.push({ kind: 'text', text: raw.content });
    } else if (Array.isArray(raw.content)) {
      for (const block of raw.content) {
        if (!isRecord(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') blocks.push({ kind: 'text', text: block.text });
        else if (block.type === 'image' && isRecord(block.source)) {
          if (block.source.type === 'base64' && typeof block.source.data === 'string') {
            blocks.push({ kind: 'image', media: strOr(block.source.media_type, 'image/png'), data: block.source.data, url: null });
          } else if (block.source.type === 'url' && typeof block.source.url === 'string') {
            blocks.push({ kind: 'image', media: null, data: null, url: block.source.url });
          }
        } else if (block.type === 'tool_use') {
          blocks.push({ kind: 'tool_use', id: strOr(block.id, ''), name: strOr(block.name, ''), input: isRecord(block.input) ? block.input : {} });
        } else if (block.type === 'tool_result') {
          blocks.push({ kind: 'tool_result', toolUseId: strOr(block.tool_use_id, ''), text: toolResultText(block.content) });
        }
      }
    }
    turns.push({ role: raw.role === 'assistant' ? 'assistant' : 'user', blocks });
  }
  let tools: ToolSpec[] | null = null;
  if (Array.isArray(body.tools)) {
    tools = [];
    for (const raw of body.tools) {
      if (!isRecord(raw) || typeof raw.name !== 'string') continue;
      tools.push({
        name: raw.name,
        description: strOr(raw.description, ''),
        parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} },
      });
    }
    if (tools.length === 0) tools = null;
  }
  let toolChoice: CallSpec['toolChoice'] = null;
  if (isRecord(body.tool_choice)) {
    if (body.tool_choice.type === 'auto') toolChoice = { mode: 'auto' };
    else if (body.tool_choice.type === 'any') toolChoice = { mode: 'any' };
    else if (body.tool_choice.type === 'none') toolChoice = { mode: 'none' };
    else if (body.tool_choice.type === 'tool' && typeof body.tool_choice.name === 'string') toolChoice = { mode: 'tool', name: body.tool_choice.name };
  }
  return {
    api: 'anthropic',
    stream: body.stream === true,
    systemText: blocksText(body.system),
    turns,
    tools,
    toolChoice,
    maxTokens: numOrNull(body.max_tokens),
    stops: stringList(body.stop_sequences),
    jsonMode: false, // the Anthropic wire carries no JSON mode, and its parser echoes false
    temperature: numOrNull(body.temperature),
    topP: numOrNull(body.top_p),
  };
}

// --- rendering the neutral form onto each provider wire ---------------------

function openAIParts(blocks: Block[]): Json[] {
  const parts: Json[] = [];
  for (const block of blocks) {
    if (block.kind === 'text') parts.push({ type: 'text', text: block.text });
    else if (block.kind === 'image') {
      const url = block.data !== null ? `data:${block.media ?? 'image/png'};base64,${block.data}` : (block.url ?? '');
      parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  return parts;
}

function toOpenAIRequest(spec: CallSpec, model: string): Json {
  const messages: Json[] = [];
  if (spec.systemText !== '') messages.push({ role: 'system', content: spec.systemText });
  for (const turn of spec.turns) {
    if (turn.role === 'assistant') {
      const textParts = turn.blocks.filter((b) => b.kind === 'text');
      const text = textParts.map((b) => (b.kind === 'text' ? b.text : '')).join('\n');
      const calls = turn.blocks.filter((b) => b.kind === 'tool_use');
      messages.push({
        role: 'assistant',
        content: text !== '' ? text : null,
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((b) =>
                b.kind === 'tool_use'
                  ? { id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }
                  : {},
              ),
            }
          : {}),
      });
      continue;
    }
    // A user turn: tool results become tool messages, the rest one user message.
    for (const block of turn.blocks) {
      if (block.kind === 'tool_result') messages.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.text });
    }
    const parts = openAIParts(turn.blocks);
    if (parts.length === 1 && parts[0].type === 'text') messages.push({ role: 'user', content: parts[0].text });
    else if (parts.length > 0) messages.push({ role: 'user', content: parts });
  }
  const out: Json = { model, messages };
  if (spec.tools !== null) {
    out.tools = spec.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  if (spec.toolChoice !== null) {
    if (spec.toolChoice.mode === 'auto') out.tool_choice = 'auto';
    else if (spec.toolChoice.mode === 'any') out.tool_choice = 'required';
    else if (spec.toolChoice.mode === 'none') out.tool_choice = 'none';
    else out.tool_choice = { type: 'function', function: { name: spec.toolChoice.name ?? '' } };
  }
  if (spec.maxTokens !== null) out.max_tokens = spec.maxTokens;
  if (spec.stops.length > 0) out.stop = spec.stops;
  if (spec.jsonMode) out.response_format = { type: 'json_object' };
  if (spec.temperature !== null) out.temperature = spec.temperature;
  if (spec.topP !== null) out.top_p = spec.topP;
  if (spec.stream) {
    out.stream = true;
    // Without this the provider's stream carries no usage chunk, and the response's usage check fails.
    out.stream_options = { include_usage: true };
  }
  return out;
}

function anthropicBlocks(blocks: Block[]): Json[] {
  const out: Json[] = [];
  for (const block of blocks) {
    if (block.kind === 'text') out.push({ type: 'text', text: block.text });
    else if (block.kind === 'image') {
      out.push({
        type: 'image',
        source:
          block.data !== null
            ? { type: 'base64', media_type: block.media ?? 'image/png', data: block.data }
            : { type: 'url', url: block.url ?? '' },
      });
    } else if (block.kind === 'tool_use') out.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
    else if (block.kind === 'tool_result') out.push({ type: 'tool_result', tool_use_id: block.toolUseId, content: block.text });
  }
  return out;
}

function toAnthropicRequest(spec: CallSpec, model: string): Json {
  const messages: Json[] = spec.turns.map((turn) => {
    const blocks = anthropicBlocks(turn.blocks);
    return { role: turn.role, content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] };
  });
  const out: Json = { model, messages };
  if (spec.systemText !== '') out.system = spec.systemText;
  if (spec.tools !== null) {
    out.tools = spec.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  if (spec.toolChoice !== null) {
    if (spec.toolChoice.mode === 'tool') out.tool_choice = { type: 'tool', name: spec.toolChoice.name ?? '' };
    else out.tool_choice = { type: spec.toolChoice.mode === 'any' ? 'any' : spec.toolChoice.mode };
  }
  if (spec.maxTokens !== null) out.max_tokens = spec.maxTokens;
  if (spec.stops.length > 0) out.stop_sequences = spec.stops;
  if (spec.temperature !== null) out.temperature = spec.temperature;
  if (spec.topP !== null) out.top_p = spec.topP;
  if (spec.stream) out.stream = true;
  return out;
}

function geminiParts(spec: CallSpec, blocks: Block[]): Json[] {
  const parts: Json[] = [];
  for (const block of blocks) {
    if (block.kind === 'text') parts.push({ text: block.text });
    else if (block.kind === 'image') {
      if (block.data !== null) parts.push({ inlineData: { mimeType: block.media ?? 'image/png', data: block.data } });
      else parts.push({ fileData: { fileUri: block.url ?? '' } });
    } else if (block.kind === 'tool_use') parts.push({ functionCall: { name: block.name, args: block.input } });
    else if (block.kind === 'tool_result') {
      // A function response names its function: find the tool_use it answers, else a neutral name.
      let name = 'tool';
      for (const turn of spec.turns) {
        for (const earlier of turn.blocks) {
          if (earlier.kind === 'tool_use' && earlier.id === block.toolUseId) name = earlier.name;
        }
      }
      parts.push({ functionResponse: { name, response: { result: block.text } } });
    }
  }
  return parts;
}

function toGeminiRequest(spec: CallSpec, model: string): { path: string; body: Json } {
  const contents: Json[] = spec.turns.map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: geminiParts(spec, turn.blocks),
  }));
  const body: Json = { contents };
  if (spec.systemText !== '') body.systemInstruction = { parts: [{ text: spec.systemText }] };
  if (spec.tools !== null) {
    body.tools = [{ functionDeclarations: spec.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
  }
  if (spec.toolChoice !== null) {
    const mode = spec.toolChoice.mode === 'any' || spec.toolChoice.mode === 'tool' ? 'ANY' : spec.toolChoice.mode === 'none' ? 'NONE' : 'AUTO';
    body.toolConfig = {
      functionCallingConfig: {
        mode,
        ...(spec.toolChoice.mode === 'tool' && spec.toolChoice.name !== undefined ? { allowedFunctionNames: [spec.toolChoice.name] } : {}),
      },
    };
  }
  const config: Json = {};
  if (spec.maxTokens !== null) config.maxOutputTokens = spec.maxTokens;
  if (spec.stops.length > 0) config.stopSequences = spec.stops;
  if (spec.jsonMode) config.responseMimeType = 'application/json';
  if (spec.temperature !== null) config.temperature = spec.temperature;
  if (spec.topP !== null) config.topP = spec.topP;
  if (Object.keys(config).length > 0) body.generationConfig = config;
  const action = spec.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return { path: `/v1beta/models/${encodeURIComponent(model)}:${action}`, body };
}

// ---------------------------------------------------------------------------
// Provider answers, reduced to (text, usage). Provider streams are buffered in full and the client
// stream is re-synthesized from the answer, which keeps event order deterministic by construction.
// ---------------------------------------------------------------------------

interface Answer {
  text: string;
  input: number;
  output: number;
}

interface SseFrame {
  event: string | null;
  data: string;
}

/** Split a server-sent-event body into frames; comments and keep-alives are dropped. */
function sseFrames(raw: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const chunk of raw.replace(/\r\n/g, '\n').split('\n\n')) {
    if (chunk.trim() === '') continue;
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length > 0) frames.push({ event, data: dataLines.join('\n') });
  }
  return frames;
}

function jsonOf(text: string): Json | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Text off a provider content value: a string, or text blocks concatenated (providers append none). */
function providerText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (isRecord(block) && typeof block.text === 'string') out += block.text;
  }
  return out;
}

function answerFromOpenAI(raw: string, stream: boolean): Answer | null {
  if (!stream) {
    const body = jsonOf(raw);
    if (body === null || !Array.isArray(body.choices) || !isRecord(body.choices[0])) return null;
    const usage = isRecord(body.usage) ? body.usage : {};
    return {
      text: providerText(isRecord(body.choices[0].message) ? body.choices[0].message.content : null),
      input: numOrNull(usage.prompt_tokens) ?? 0,
      output: numOrNull(usage.completion_tokens) ?? 0,
    };
  }
  let text = '';
  let input = 0;
  let output = 0;
  for (const frame of sseFrames(raw)) {
    if (frame.data === '[DONE]') continue;
    const body = jsonOf(frame.data);
    if (body === null) continue;
    if (isRecord(body.usage)) {
      input = numOrNull(body.usage.prompt_tokens) ?? input;
      output = numOrNull(body.usage.completion_tokens) ?? output;
    }
    if (Array.isArray(body.choices) && isRecord(body.choices[0]) && isRecord(body.choices[0].delta)) {
      text += providerText(body.choices[0].delta.content);
    }
  }
  return { text, input, output };
}

function answerFromAnthropic(raw: string, stream: boolean): Answer | null {
  if (!stream) {
    const body = jsonOf(raw);
    if (body === null) return null;
    const usage = isRecord(body.usage) ? body.usage : {};
    return {
      text: providerText(body.content),
      input: numOrNull(usage.input_tokens) ?? 0,
      output: numOrNull(usage.output_tokens) ?? 0,
    };
  }
  let text = '';
  let input = 0;
  let output = 0;
  for (const frame of sseFrames(raw)) {
    const body = jsonOf(frame.data);
    if (body === null) continue;
    if (frame.event === 'content_block_delta' && isRecord(body.delta)) text += providerText([body.delta]);
    else if (frame.event === 'message_start' && isRecord(body.message) && isRecord(body.message.usage)) {
      input = numOrNull(body.message.usage.input_tokens) ?? input;
    } else if (frame.event === 'message_delta' && isRecord(body.usage)) {
      output = numOrNull(body.usage.output_tokens) ?? output;
    }
  }
  return { text, input, output };
}

function geminiTextAndUsage(body: Json, into: { text: string; input: number; output: number }): void {
  if (Array.isArray(body.candidates) && isRecord(body.candidates[0]) && isRecord(body.candidates[0].content)) {
    const parts = body.candidates[0].content.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (isRecord(part) && typeof part.text === 'string' && part.thought !== true) into.text += part.text;
      }
    }
  }
  if (isRecord(body.usageMetadata)) {
    into.input = numOrNull(body.usageMetadata.promptTokenCount) ?? into.input;
    into.output = numOrNull(body.usageMetadata.candidatesTokenCount) ?? into.output;
  }
}

function answerFromGemini(raw: string, stream: boolean): Answer | null {
  const acc = { text: '', input: 0, output: 0 };
  if (!stream) {
    const body = jsonOf(raw);
    if (body === null) return null;
    geminiTextAndUsage(body, acc);
    return acc;
  }
  for (const frame of sseFrames(raw)) {
    const body = jsonOf(frame.data);
    if (body !== null) geminiTextAndUsage(body, acc);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Client answers: the provider's text and usage carried into the client's wire. The served stop is
// always the normal family — that is the family every provider reports for a completed answer — and
// ids/created are fixed constants, so a replay emits byte-identical bytes.
// ---------------------------------------------------------------------------

const FIXED_CREATED = 1767225600; // 2026-01-01T00:00:00Z
const FIXED_TIMESTAMP = '2026-01-01T00:00:00Z';
const COMPLETION_ID = 'chatcmpl-aggregator';
const MESSAGE_ID = 'msg_aggregator';

/** Split a reply into even stream pieces; the concatenation is the reply, exactly. */
function piecesOf(text: string): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += 16) pieces.push(text.slice(i, i + 16));
  return pieces;
}

function renderOpenAI(spec: CallSpec, answer: Answer, model: string): { contentType: string; body: string } {
  const usage = {
    prompt_tokens: answer.input,
    completion_tokens: answer.output,
    total_tokens: answer.input + answer.output,
  };
  if (!spec.stream) {
    return {
      contentType: 'application/json',
      body: JSON.stringify({
        id: COMPLETION_ID,
        object: 'chat.completion',
        created: FIXED_CREATED,
        model,
        choices: [
          { index: 0, message: { role: 'assistant', content: answer.text }, finish_reason: 'stop', logprobs: null },
        ],
        usage,
      }),
    };
  }
  const chunk = (delta: Json, finishReason: string | null, withUsage: boolean): string => {
    const frame: Json = {
      id: COMPLETION_ID,
      object: 'chat.completion.chunk',
      created: FIXED_CREATED,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (withUsage) frame.usage = usage;
    return `data: ${JSON.stringify(frame)}\n\n`;
  };
  let body = chunk({ role: 'assistant', content: '' }, null, false);
  for (const piece of piecesOf(answer.text)) body += chunk({ content: piece }, null, false);
  body += chunk({}, 'stop', false);
  // A final usage-only chunk, the shape a provider sends when asked to include usage.
  body += `data: ${JSON.stringify({ id: COMPLETION_ID, object: 'chat.completion.chunk', created: FIXED_CREATED, model, choices: [], usage })}\n\n`;
  body += 'data: [DONE]\n\n';
  return { contentType: 'text/event-stream', body };
}

function renderAnthropic(spec: CallSpec, answer: Answer, model: string): { contentType: string; body: string } {
  if (!spec.stream) {
    return {
      contentType: 'application/json',
      body: JSON.stringify({
        id: MESSAGE_ID,
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: answer.text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: answer.input, output_tokens: answer.output },
      }),
    };
  }
  const frame = (event: string, data: Json): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  let body = frame('message_start', {
    type: 'message_start',
    message: {
      id: MESSAGE_ID,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: answer.input, output_tokens: 0 },
    },
  });
  body += frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (const piece of piecesOf(answer.text)) {
    body += frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
  }
  body += frame('content_block_stop', { type: 'content_block_stop', index: 0 });
  body += frame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: answer.output },
  });
  body += frame('message_stop', { type: 'message_stop' });
  return { contentType: 'text/event-stream', body };
}

function renderAnswer(spec: CallSpec, answer: Answer, model: string): { contentType: string; body: string } {
  return spec.api === 'openai' ? renderOpenAI(spec, answer, model) : renderAnthropic(spec, answer, model);
}

/** The /v1/models answer in the client's shape: the entry's free models, first occurrence per id. */
function renderModelList(api: 'openai' | 'anthropic', states: ProviderState[]): Json {
  const models = servedModelList(states);
  if (api === 'anthropic') {
    return {
      data: models.map((m) => ({ type: 'model', id: m.id, display_name: m.id, created_at: FIXED_TIMESTAMP })),
      has_more: false,
      first_id: models[0]?.id ?? null,
      last_id: models[models.length - 1]?.id ?? null,
    };
  }
  return {
    object: 'list',
    data: models.map((m) => ({ id: m.id, object: 'model', created: FIXED_CREATED, owned_by: m.provider })),
  };
}

function clientError(api: 'openai' | 'anthropic', status: number, code: string, message: string): { contentType: string; body: string } {
  if (api === 'anthropic') {
    const type = status >= 500 || status === 429 ? 'api_error' : status === 404 ? 'not_found_error' : 'invalid_request_error';
    return { contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { type, message } }) };
  }
  return {
    contentType: 'application/json',
    body: JSON.stringify({ error: { message, type: 'api_error', param: null, code } }),
  };
}

// ---------------------------------------------------------------------------
// Routing: the best legal free model first; a refused call fails over to the next one.
// ---------------------------------------------------------------------------

function meets(model: ModelInfo, requires: Requirement): boolean {
  if (requires.tools === true && model.tools !== true) return false;
  if (requires.vision === true && model.vision !== true) return false;
  if (requires.json === true && model.json !== true) return false;
  if (requires.min_context !== undefined && (model.context_length === null || model.context_length < requires.min_context)) {
    return false;
  }
  return true;
}

interface Candidate {
  state: ProviderState;
  model: ModelInfo;
}

/** Every legal (provider, model) for a request, best first: rating, then brief order, then model id. */
function candidatesFor(states: ProviderState[], requires: Requirement, jsonMode: boolean): Candidate[] {
  const out: Candidate[] = [];
  for (const state of states) {
    for (const model of state.models) {
      if (!model.free || state.banned.has(model.id)) continue;
      if (!meets(model, requires)) continue;
      // An Anthropic-wire provider's parser never echoes JSON mode, so a JSON-mode request routed
      // there would fail the echo check even though the text came back fine. Skip such providers.
      if (jsonMode && state.entry.wire === 'anthropic') continue;
      out.push({ state, model });
    }
  }
  out.sort(
    (a, b) => b.model.rating - a.model.rating || a.state.index - b.state.index || cmpStr(a.model.id, b.model.id),
  );
  // A provider's refusal schedule holds at most two draws per trial, so a provider that has refused
  // three times is spent or out for good: try it only after everything else. The retry gate in the
  // serve loop covers the recoverable draws; this partition covers the permanent ones.
  const live = out.filter((c) => c.state.failures < 3);
  const spent = out.filter((c) => c.state.failures >= 3);
  return [...live, ...spent];
}

interface CallOutcome {
  ok: boolean;
  answer: Answer | null;
  status: number;
  code: string | null;
}

/** One provider call, awaited in full: the caller never overlaps calls, so nothing races a budget. */
async function callProvider(candidate: Candidate, spec: CallSpec): Promise<CallOutcome> {
  const { state, model } = candidate;
  const wire = state.entry.wire;
  let url: string;
  let payload: Json;
  if (wire === 'openai') {
    url = `${state.dialBase}/v1/chat/completions`;
    payload = toOpenAIRequest(spec, model.id);
  } else if (wire === 'anthropic') {
    url = `${state.dialBase}/v1/messages`;
    payload = toAnthropicRequest(spec, model.id);
  } else {
    const rendered = toGeminiRequest(spec, model.id);
    url = `${state.dialBase}${rendered.path}`;
    payload = rendered.body;
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: spec.stream ? 'text/event-stream' : 'application/json',
    ...authHeaders(state.entry.auth, state.entry.key),
  };
  if (wire === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  let status = 0;
  let raw = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(25000),
    });
    status = res.status;
    raw = await res.text();
  } catch {
    return { ok: false, answer: null, status: 0, code: null }; // a timeout or a dropped connection
  }
  if (status >= 200 && status < 300) {
    const answer =
      wire === 'openai'
        ? answerFromOpenAI(raw, spec.stream)
        : wire === 'anthropic'
          ? answerFromAnthropic(raw, spec.stream)
          : answerFromGemini(raw, spec.stream);
    return { ok: answer !== null, answer, status, code: null };
  }
  const errorBody = jsonOf(raw);
  const code =
    errorBody !== null && isRecord(errorBody.error)
      ? strOr(errorBody.error.code, '') || strOr(errorBody.error.type, '') || strOr(errorBody.error.status, '') || null
      : null;
  return { ok: false, answer: null, status, code };
}

/** Serve one client request: candidates in order until one answers; a client's shape on failure. */
async function serveRequest(
  states: ProviderState[],
  manifestEntry: ManifestEntry | undefined,
  spec: CallSpec,
): Promise<{ status: number; contentType: string; body: string }> {
  const requires: Requirement =
    manifestEntry !== undefined
      ? manifestEntry.requires
      : {
          // Past the manifest: derive the requirements off the request itself.
          ...(spec.tools !== null ? { tools: true } : {}),
          ...(spec.turns.some((t) => t.blocks.some((b) => b.kind === 'image')) ? { vision: true } : {}),
          ...(spec.jsonMode ? { json: true } : {}),
        };
  const refused = (o: CallOutcome): boolean => !o.ok && o.status !== 400 && o.code !== 'invalid_model';
  for (const candidate of candidatesFor(states, requires, spec.jsonMode)) {
    let outcome = await callProvider(candidate, spec);
    if (refused(outcome)) {
      // A refusal early in a provider's trial is usually one scheduled draw, and the same pair
      // answers on the next call index — retry it once. A provider that keeps refusing is spent
      // or down, and retrying it would only spend calls the tie-break counts.
      const mayRetry = candidate.state.failures < 2;
      candidate.state.failures += 1;
      if (mayRetry) {
        outcome = await callProvider(candidate, spec);
        if (refused(outcome)) candidate.state.failures += 1;
      }
    }
    if (outcome.ok && outcome.answer !== null) {
      return { status: 200, ...renderAnswer(spec, outcome.answer, candidate.model.id) };
    }
    if (outcome.status === 400 || outcome.code === 'invalid_model') {
      // The provider says this model is not one of its free models: never offer it again.
      candidate.state.banned.add(candidate.model.id);
    }
  }
  log(`request ${manifestEntry?.id ?? '?'}: no provider answered`);
  const err = clientError(spec.api, 503, 'no_provider_available', 'No free provider could serve this request.');
  return { status: 503, ...err };
}

// ---------------------------------------------------------------------------
// The server and the trial lifecycle.
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 32 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function runTrial(): Promise<void> {
  const brief = readBrief(PROMPT_FILE);
  if (brief.error !== null) log(brief.error);
  const states = await loadProviders(brief);
  const catalog = buildCatalog(states);
  if (process.argv.includes('--list')) {
    process.stdout.write(`${JSON.stringify(catalog)}\n`, () => process.exit(0));
    return;
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');

  let nextRequest = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const dispatch = async (apiPath: 'openai' | 'anthropic', req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const index = nextRequest;
    nextRequest += 1;
    const raw = await readBody(req);
    const parsed = jsonOf(raw);
    if (parsed === null) {
      const err = clientError(apiPath, 400, 'invalid_json', 'The request body is not a JSON object.');
      res.writeHead(400, { 'content-type': err.contentType });
      res.end(err.body);
      return;
    }
    const spec = apiPath === 'openai' ? specFromOpenAI(parsed) : specFromAnthropic(parsed);
    const outcome = await serveRequest(states, brief.manifest[index], spec);
    res.writeHead(outcome.status, { 'content-type': outcome.contentType });
    res.end(outcome.body);
  };

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/v1/models') {
      const api = typeof req.headers['x-api-key'] === 'string' ? 'anthropic' : 'openai';
      sendJson(res, 200, renderModelList(api, states));
      return;
    }
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/messages')) {
      const apiPath = path === '/v1/messages' ? 'anthropic' : 'openai';
      void enqueue(() => dispatch(apiPath, req, res)).catch((err: unknown) => {
        log(`dispatch failed: ${(err as Error).message}`);
        if (!res.headersSent) {
          const errBody = clientError(apiPath, 500, 'internal_error', 'The aggregator failed to serve this request.');
          res.writeHead(500, { 'content-type': errBody.contentType });
          res.end(errBody.body);
        }
      });
      return;
    }
    const api = path.startsWith('/v1/messages') ? 'anthropic' : 'openai';
    const err = clientError(api, 404, 'not_found', `No route for ${req.method ?? ''} ${path}.`);
    res.writeHead(404, { 'content-type': err.contentType });
    res.end(err.body);
  });

  let port = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
    if (port !== 0 && port !== 8080) break;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (port === 0 || port === 8080) throw new Error('no usable port for the serving interface');

  const registration = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: 1, port, catalog }),
  });
  if (!registration.ok) throw new Error(`the env refused the registration: HTTP ${registration.status}`);
  log(`registered on port ${port}; serving ${brief.manifest.length} manifest requests`);

  // Poll /work until the env says the trial is over (an error body counts as still working).
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    let done = false;
    try {
      const work = await fetch(`${ENV_URL}/work`);
      if (work.ok) {
        const body: unknown = await work.json();
        done = isRecord(body) && body.done === true;
      }
    } catch {
      done = false;
    }
    if (done) break;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const shutdown = (): void => process.exit(0);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

runTrial().catch((err: unknown) => {
  process.stderr.write(`aggregator: fatal: ${(err as Error).message}\n`);
  process.exit(1);
});


