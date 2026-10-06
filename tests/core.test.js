import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBatches, buildInitialRequest, buildShortlistBatches, buildShortlistRequest, isExcluded, normalizeDomain, parseInitialResponse, parseShortlistResponse, utf8Bytes } from '../extension/core.js';

test('normalizes domains and includes subdomains', () => {
  assert.equal(normalizeDomain('https://WWW.Example.com/path'), 'www.example.com');
  assert.equal(isExcluded('https://docs.example.com/a', ['example.com']), true);
  assert.equal(isExcluded('https://example.com.evil.test', ['example.com']), false);
  assert.equal(isExcluded('https://example.com/a', ['www.example.com']), false);
  assert.equal(isExcluded('https://www.example.com/a', ['www.example.com']), true);
});

test('batches every block without dropping IDs', () => {
  const blocks = Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, text: `text ${i}` }));
  const batches = buildBatches('find', blocks, { maxOptions: 2, maxBytes: 100000 });
  assert.deepEqual(batches.flat().map(({ id }) => id), blocks.map(({ id }) => id));
  assert.ok(batches.every((batch) => batch.length <= 2));
});

test('builds Choice plus Noul and validates response IDs', () => {
  const request = buildInitialRequest('find', [{ id: 'a', text: 'answer' }]);
  assert.equal(request.questions.best_match.type, 'choice');
  assert.equal(request.questions.has_match.type, 'noul');
  const parsed = parseInitialResponse({ answers: { best_match: { type: 'choice', choice: 'a', confidence: 0.9, probabilities: { no_match: 0.1, a: 0.9 } }, has_match: { type: 'noul', noul: 0.9 } } }, request.state.blocks);
  assert.deepEqual(parsed.candidates, [{ id: 'a', score: 0.9 }]);
  assert.throws(() => parseInitialResponse({ answers: { best_match: { type: 'choice', choice: 'unknown', confidence: 1, probabilities: { no_match: 0, a: 1 } }, has_match: { type: 'noul', noul: 1 } } }, request.state.blocks));
  assert.throws(() => parseInitialResponse({ answers: { best_match: { type: 'choice', choice: 'a', confidence: 1, probabilities: { no_match: 0, a: '1' } }, has_match: { type: 'noul', noul: 1 } } }, request.state.blocks));
  assert.throws(() => parseInitialResponse({ answers: { best_match: { type: 'choice', choice: 'a', confidence: 1, probabilities: { no_match: 0, a: 0 } }, has_match: { type: 'noul', noul: 1 } } }, request.state.blocks));
});

test('ranks rounded Choice probabilities without requiring unused confidence', () => {
  const request = buildInitialRequest('find', [{ id: 'a', text: 'answer' }, { id: 'b', text: 'other' }]);
  const parsed = parseInitialResponse({ answers: { best_match: { type: 'choice', choice: 'a', probabilities: { no_match: 0.0004, a: 0.9989, b: 0 }, }, has_match: { type: 'noul', noul: 0.8 } } }, request.state.blocks);
  assert.deepEqual(parsed.candidates.map(({ id }) => id), ['a', 'b']);
  assert.ok(Math.abs(parsed.candidates[0].score - (0.9989 / 0.9993)) < 1e-12);
  assert.throws(() => parseInitialResponse({ answers: { best_match: { type: 'choice', choice: 'a', probabilities: { no_match: 0.05, a: 1.1, b: 0.05 } }, has_match: { type: 'noul', noul: 0.8 } } }, request.state.blocks));
});

test('normalizes a rounded 111-option distribution and leaves presence to Noul', () => {
  const blocks = Array.from({ length: 110 }, (_, index) => ({ id: `b${index}`, text: `block ${index}` }));
  const request = buildInitialRequest('find', blocks);
  const probabilities = Object.fromEntries([['no_match', 0.05], ...blocks.map(({ id }, index) => [id, index === 0 ? 0.94 : 0])]);
  const withMatch = parseInitialResponse({ answers: { best_match: { type: 'choice', choice: 'b0', probabilities }, has_match: { type: 'noul', noul: 0.8 } } }, request.state.blocks);
  assert.equal(withMatch.candidates[0].id, 'b0');
  assert.ok(Math.abs(withMatch.candidates[0].score - (0.94 / 0.99)) < 1e-12);
  const withoutMatch = parseInitialResponse({ answers: { best_match: { type: 'choice', choice: 'b0', probabilities }, has_match: { type: 'noul', noul: 0.1 } } }, request.state.blocks);
  assert.deepEqual(withoutMatch.candidates, []);
});

test('returns no candidates when a batch has no possible match', () => {
  const request = buildInitialRequest('find', [{ id: 'a', text: 'answer' }]);
  const parsed = parseInitialResponse({ answers: { best_match: { type: 'choice', choice: 'no_match', confidence: 0.9, probabilities: { no_match: 0.9, a: 0.1 } }, has_match: { type: 'noul', noul: 0.1 } } }, request.state.blocks);
  assert.deepEqual(parsed.candidates, []);
});

test('shortlist batching measures the exact final request body', () => {
  const candidate = [{ id: 'a', text: 'x'.repeat(6000) }];
  const request = buildShortlistRequest('q', candidate);
  assert.throws(() => buildShortlistBatches('q', candidate, { maxBytes: utf8Bytes(request) - 1 }), /byte budget/);
  assert.equal(buildShortlistBatches('q', candidate, { maxBytes: utf8Bytes(request) }).length, 1);
});

test('shortlist uses one Noul per candidate and returns thresholds', () => {
  const request = buildShortlistRequest('find', [{ id: 'a', text: 'answer' }, { id: 'b', text: 'maybe' }]);
  assert.deepEqual(Object.keys(request.questions), ['match_a', 'match_b']);
  const parsed = parseShortlistResponse({ answers: { match_a: { type: 'noul', noul: 0.8 }, match_b: { type: 'noul', noul: 0.4 } } }, [{ id: 'a', text: 'answer' }, { id: 'b', text: 'maybe' }]);
  assert.deepEqual(parsed.results, [{ id: 'a', score: 0.8 }]);
  assert.deepEqual(parsed.possible, [{ id: 'a', score: 0.8 }, { id: 'b', score: 0.4 }]);
});
