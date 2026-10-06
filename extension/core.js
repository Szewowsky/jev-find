// ponytail: byte budgets are conservative; use a provider tokenizer if token limits repeatedly fail.
const DEFAULTS = Object.freeze({ maxOptions: 200, maxBytes: 27000, shortlistSize: 12, initialPerBatch: 5, goodThreshold: 0.7, possibleThreshold: 0.35 });
const MAX_BLOCKS = 10000;
const MAX_BLOCK_TEXT = 12000;
const MAX_ID_LENGTH = 128;
const encoder = new TextEncoder();

export function utf8Bytes(value) { return encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength; }

export function normalizeDomain(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const input = /^[a-z][a-z\d+.-]*:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
    return new URL(input).hostname.toLowerCase().replace(/^\.+|\.+$/g, '');
  } catch { return ''; }
}

export function isExcluded(urlOrDomain, excludedDomains = []) {
  const domain = normalizeDomain(urlOrDomain);
  return Boolean(domain && Array.isArray(excludedDomains) && excludedDomains.some((item) => {
    const excluded = normalizeDomain(item);
    return excluded && (domain === excluded || domain.endsWith(`.${excluded}`));
  }));
}

function cleanBlock(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block) || typeof block.id !== 'string' || block.id.length > MAX_ID_LENGTH || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(block.id) || typeof block.text !== 'string' || !block.text.trim() || block.text.length > MAX_BLOCK_TEXT) throw new TypeError('blocks must contain bounded safe IDs and text');
  return { id: block.id, text: block.text };
}

export function validateBlocks(blocks) {
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > MAX_BLOCKS) throw new TypeError('blocks must be a bounded non-empty array');
  const result = blocks.map(cleanBlock);
  if (new Set(result.map(({ id }) => id)).size !== result.length) throw new TypeError('block ids must be unique');
  return result;
}

export function validateQuery(query) {
  if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw new TypeError('query must be a non-empty bounded string');
  return query;
}

function idsOf(items) {
  if (!Array.isArray(items) || !items.length) throw new TypeError('expected a non-empty ID list');
  const ids = items.map((item) => typeof item === 'string' ? item : item?.id);
  if (ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))) throw new TypeError('invalid candidate ID');
  if (new Set(ids).size !== ids.length) throw new TypeError('candidate IDs must be unique');
  return ids;
}

function initialQuestions(ids) {
  return {
    best_match: { type: 'choice', instructions: 'Using `state.query` and the `text` field of each object in `state.blocks`, choose the block `id` whose text best answers the query. Choose no_match when no block is useful.', criteria: Object.fromEntries(['no_match', ...ids].map((id) => [id, id === 'no_match' ? 'No block is a useful answer.' : `The block with id ${id}.`])) },
    has_match: { type: 'noul', instructions: 'Using `state.query` and the `text` fields in `state.blocks`, is any block a useful answer? Answer yes only when a useful match exists.' },
  };
}

export function buildBatches(query, blocks, options = {}) {
  validateQuery(query);
  const all = validateBlocks(blocks);
  const maxOptions = options.maxOptions ?? DEFAULTS.maxOptions;
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  if (!Number.isInteger(maxOptions) || maxOptions < 1 || maxOptions > 200 || !Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError('invalid batch limits');
  const batches = [];
  let batch = [];
  for (const block of all) {
    const candidate = [...batch, block];
    if (candidate.length > maxOptions || utf8Bytes(buildInitialRequest(query, candidate)) > maxBytes) {
      if (!batch.length) throw new RangeError(`block ${block.id} exceeds request byte budget`);
      batches.push(batch);
      batch = [block];
      if (utf8Bytes(buildInitialRequest(query, batch)) > maxBytes) throw new RangeError(`block ${block.id} exceeds request byte budget`);
    } else batch = candidate;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function buildInitialRequest(query, blocks) {
  validateQuery(query);
  const batch = validateBlocks(blocks);
  return { state: { query, blocks: batch }, model: 'jev-latest', questions: initialQuestions(batch.map(({ id }) => id)) };
}

export function buildInitialRequests(query, blocks, options = {}) { return buildBatches(query, blocks, options).map((batch) => buildInitialRequest(query, batch)); }

export function buildShortlistRequest(query, candidates) {
  validateQuery(query);
  const blocks = validateBlocks(candidates);
  return {
    state: { query, candidates: blocks },
    model: 'jev-latest',
    questions: Object.fromEntries(blocks.map(({ id }) => [`match_${id}`, { type: 'noul', instructions: `Using \`state.query\` and the candidate object in \`state.candidates\` whose \`id\` is ${JSON.stringify(id)}, does that candidate's \`text\` field directly answer the query? Answer yes only for a useful match.` }])),
  };
}

export function buildShortlistBatches(query, candidates, options = {}) {
  validateQuery(query);
  const all = validateBlocks(candidates);
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError('invalid batch limits');
  const batches = [];
  let batch = [];
  for (const block of all) {
    const candidate = [...batch, block];
    if (utf8Bytes(buildShortlistRequest(query, candidate)) > maxBytes) {
      if (!batch.length) throw new RangeError(`candidate ${block.id} exceeds request byte budget`);
      batches.push(batch);
      batch = [block];
      if (utf8Bytes(buildShortlistRequest(query, batch)) > maxBytes) throw new RangeError(`candidate ${block.id} exceeds request byte budget`);
    } else batch = candidate;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function answersOf(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response) || !response.answers || typeof response.answers !== 'object' || Array.isArray(response.answers)) throw new TypeError('invalid JEV response: answers missing');
  return response.answers;
}

function validProbabilityMap(probabilities, allowed) {
  if (!probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)) throw new TypeError('choice probabilities missing');
  const keys = Object.keys(probabilities);
  if (keys.length !== allowed.size || keys.some((id) => !allowed.has(id))) throw new TypeError('choice probabilities have invalid IDs');
  const values = keys.map((id) => probabilities[id]);
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) throw new TypeError('choice probabilities out of range');
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) throw new TypeError('choice probabilities out of range');
  return Object.fromEntries(keys.map((id, index) => [id, values[index] / total]));
}

function validNoul(answer) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) || answer.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new TypeError('invalid JEV Noul answer');
  return answer.noul;
}

function expectedAnswers(answers, expected) {
  const keys = Object.keys(answers);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) throw new TypeError('JEV answers have missing or foreign IDs');
}

function safeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    input_tokens: typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0,
    output_tokens: typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0,
  };
}

export function parseInitialResponse(response, allowedBlocks, options = {}) {
  const ids = idsOf(allowedBlocks);
  const allowed = new Set(['no_match', ...ids]);
  const answers = answersOf(response);
  expectedAnswers(answers, ['best_match', 'has_match']);
  const choice = answers.best_match;
  const presence = answers.has_match;
  if (!choice || typeof choice !== 'object' || Array.isArray(choice) || choice.type !== 'choice' || typeof choice.choice !== 'string' || !allowed.has(choice.choice)) throw new TypeError('invalid JEV choice answer');
  validNoul(presence);
  const probabilities = validProbabilityMap(choice.probabilities, allowed);
  const top = Object.entries(probabilities).filter(([id]) => id !== 'no_match').sort((a, b) => b[1] - a[1]).slice(0, options.initialPerBatch ?? DEFAULTS.initialPerBatch).map(([id, score]) => ({ id, score }));
  return { candidates: presence.noul >= (options.possibleThreshold ?? DEFAULTS.possibleThreshold) ? top : [], usage: safeUsage(response.usage) };
}

export function parseShortlistResponse(response, expectedBlocks, options = {}) {
  const ids = idsOf(expectedBlocks);
  const answers = answersOf(response);
  expectedAnswers(answers, ids.map((id) => `match_${id}`));
  const possible = ids.map((id) => {
    const answer = answers[`match_${id}`];
    return { id, score: validNoul(answer) };
  }).filter(({ score }) => score >= (options.possibleThreshold ?? DEFAULTS.possibleThreshold)).sort((a, b) => b.score - a.score);
  const limit = options.shortlistSize ?? DEFAULTS.shortlistSize;
  return { results: possible.filter(({ score }) => score >= (options.goodThreshold ?? DEFAULTS.goodThreshold)).slice(0, limit), possible: possible.slice(0, limit), usage: safeUsage(response.usage) };
}

export { DEFAULTS };
