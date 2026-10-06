import test from 'node:test';
import assert from 'node:assert/strict';
import { createGate, GRANT_MS, PAUSE_MS } from '../extension/gate.js';

const KEY = { hasKey: true, excluded: false, unsupported: false };

// A gate as the bar sees it right after opening: granted, session ready, key known.
function opened({ at = 0, config = KEY, revision = 1 } = {}) {
  let clock = at;
  const gate = createGate({ now: () => clock });
  gate.grant();
  gate.ready();
  gate.configure(config, revision);
  return { gate, tick(ms) { clock += ms; } };
}

function typeText(gate, text, composing = false) {
  return gate.input(text, composing);
}

test('typing while present arms one pause and yields exactly one permit for the final version', () => {
  const { gate } = opened();
  assert.equal(typeText(gate, 'o'), true);
  assert.equal(typeText(gate, 'op'), true);
  assert.equal(typeText(gate, 'opis'), true);
  assert.equal(gate.pauseElapsed(1), null, 'a pause of an older version is void');
  assert.deepEqual(gate.pauseElapsed(3), { permit: 1, version: 3, cause: 'pause' });
  assert.equal(gate.pauseElapsed(3), null, 'a pause is consumed once');
  assert.ok(PAUSE_MS === 450);
});

test('Enter during a pending pause replaces it; Enter on searched text is a new approval', () => {
  const { gate } = opened();
  typeText(gate, 'opis');
  assert.deepEqual(gate.approve('enter'), { permit: 1, version: 1, cause: 'enter' });
  assert.equal(gate.pauseElapsed(1), null, 'the pause gives no second search');
  assert.deepEqual(gate.approve('enter'), { permit: 2, version: 1, cause: 'enter' });
});

test('losing focus ends presence; later text is unconfirmed and needs a present approval', () => {
  const { gate } = opened();
  gate.blur();
  assert.equal(gate.state.present, false);
  assert.equal(typeText(gate, 'przechwycone'), false, 'no pause without presence');
  assert.equal(gate.offersSemantic(), true, 'the bar offers Szukaj po znaczeniu');
  assert.equal(gate.approve('enter'), null, 'Enter without presence approves nothing');
  assert.equal(gate.approve('semantic'), null, 'a keyboard click without presence approves nothing');
  assert.equal(gate.state.confirmed, false);
});

test('a pause armed before focus loss dies with it and its text needs approval', () => {
  const { gate } = opened();
  typeText(gate, 'opis');
  gate.blur();
  assert.equal(gate.pauseElapsed(1), null);
  assert.equal(gate.offersSemantic(), true);
});

test('focus never grants presence; focus without a fresh grant ends it', () => {
  const { gate, tick } = opened();
  tick(GRANT_MS - 1);
  gate.focus();
  assert.equal(gate.state.present, true, 'the focus that follows opening keeps presence');
  gate.blur();
  gate.focus();
  assert.equal(gate.state.present, false, 'returning focus does not restore presence');
  gate.grant();
  tick(GRANT_MS + 1);
  gate.focus();
  assert.equal(gate.state.present, false, 'a grant without focus expires when focus arrives late (Tab, page)');
});

test('a trusted pointer press or the shortcut restores presence and approval', () => {
  const { gate, tick } = opened();
  gate.blur();
  typeText(gate, 'przechwycone');
  tick(5000);
  gate.grant();
  gate.focus();
  assert.equal(gate.state.present, true);
  assert.deepEqual(gate.approve('semantic'), { permit: 1, version: 1, cause: 'semantic' });
  assert.equal(typeText(gate, 'przechwycone!'), true, 'typing after the grant is confirmed again');
});

test('moving focus inside the bar keeps presence', () => {
  const { gate } = opened();
  // Tab between the field and buttons fires no window focus or blur, so the gate sees nothing.
  assert.equal(typeText(gate, 'opis'), true);
  assert.equal(gate.state.present, true);
});

test('composition gives literal updates only; the pause starts after it ends', () => {
  const { gate } = opened();
  typeText(gate, 'ab');
  gate.compositionStart();
  assert.equal(gate.pauseElapsed(1), null, 'starting a composition cancels the pending pause');
  assert.equal(typeText(gate, 'abㄱ', true), false);
  assert.equal(typeText(gate, 'ab가', true), false);
  assert.equal(gate.pauseElapsed(3), null, 'a composition longer than the pause sends nothing');
  assert.equal(gate.compositionEnd(), true, 'ending the composition arms the pause');
  assert.deepEqual(gate.pauseElapsed(3), { permit: 1, version: 3, cause: 'pause' });
});

test('a settings revision is one cause: one search for confirmed text, replacing a pending pause', () => {
  const { gate } = opened({ revision: 4 });
  typeText(gate, 'opis');
  assert.deepEqual(gate.configure(KEY, 5), { permit: { permit: 1, version: 1, cause: 'settings' }, arm: false });
  assert.equal(gate.pauseElapsed(1), null, 'the pause is replaced, total 1');
  assert.deepEqual(gate.configure(KEY, 5), { permit: null, arm: false }, 'a repeated revision is ignored');
  assert.deepEqual(gate.configure(KEY, 3), { permit: null, arm: false }, 'an older revision is ignored');
});

test('a settings revision during a composition sends nothing until the composition ends', () => {
  const { gate } = opened({ revision: 1 });
  gate.compositionStart();
  typeText(gate, 'ㄱ', true);
  assert.deepEqual(gate.configure(KEY, 2), { permit: null, arm: false }, 'no search for the unfinished text');
  assert.equal(gate.compositionEnd(), true, 'the end of the composition arms the pause');
  assert.deepEqual(gate.pauseElapsed(1), { permit: 1, version: 1, cause: 'pause' });
});

test('a settings revision sends nothing for unconfirmed text, a removed key or an excluded domain', () => {
  const { gate } = opened({ revision: 1 });
  gate.blur();
  typeText(gate, 'obce');
  assert.equal(gate.configure(KEY, 2).permit, null, 'unconfirmed text');
  gate.grant();
  typeText(gate, 'moje');
  gate.approve('enter');
  assert.equal(gate.configure({ ...KEY, hasKey: false }, 3).permit, null, 'key removed');
  assert.equal(gate.configure({ ...KEY, excluded: true }, 4).permit, null, 'domain excluded');
  assert.equal(gate.configure(KEY, 5).permit.cause, 'settings', 'key back for confirmed text');
});

test('the first known revision is only a baseline, also when it arrives after typing', () => {
  let clock = 0;
  const gate = createGate({ now: () => clock });
  gate.grant();
  gate.ready();
  assert.equal(typeText(gate, 'opis'), false, 'no key known yet');
  assert.deepEqual(gate.configure(KEY, 9), { permit: null, arm: true }, 'baseline arms the pause for the typed text');
  assert.deepEqual(gate.pauseElapsed(1), { permit: 1, version: 1, cause: 'pause' });
  assert.deepEqual(gate.configure(KEY, 9), { permit: null, arm: false }, 'searched text is not armed again');
});

test('nothing is issued before the session is ready; ready arms text typed meanwhile', () => {
  let clock = 0;
  const gate = createGate({ now: () => clock });
  gate.grant();
  gate.configure(KEY, 1);
  assert.equal(typeText(gate, 'opis'), false);
  assert.equal(gate.approve('enter'), null);
  assert.equal(gate.ready(), true);
  assert.deepEqual(gate.pauseElapsed(1), { permit: 1, version: 1, cause: 'pause' });
});

test('permit numbers strictly increase across causes', () => {
  const { gate } = opened();
  typeText(gate, 'a');
  const first = gate.pauseElapsed(1);
  const second = gate.approve('enter');
  typeText(gate, 'ab');
  const third = gate.approve('retry');
  assert.deepEqual([first.permit, second.permit, third.permit], [1, 2, 3]);
  assert.equal(third.version, 2);
});

test('empty or whitespace text and an unsupported page never yield permits', () => {
  const { gate } = opened();
  assert.equal(typeText(gate, '   '), false);
  assert.equal(gate.approve('enter'), null);
  gate.configure({ ...KEY, unsupported: true }, 2);
  typeText(gate, 'opis');
  assert.equal(gate.approve('enter'), null);
});

test('focus without a fresh grant ends presence like a blur: the pending pause dies and its text needs approval', () => {
  const { gate, tick } = opened();
  typeText(gate, 'opis');
  tick(GRANT_MS + 1);
  gate.focus();
  assert.equal(gate.state.present, false);
  assert.equal(gate.pauseElapsed(1), null, 'no pause permit after presence ended');
  assert.equal(gate.offersSemantic(), true, 'the text needs Szukaj po znaczeniu');
});

test('text typed while present but not searched yet needs approval after focus loss, whatever re-arms later', () => {
  const ime = opened();
  ime.gate.compositionStart();
  typeText(ime.gate, 'ㄱ', true);
  ime.gate.blur();
  assert.equal(ime.gate.compositionEnd(), false, 'the end of an interrupted composition arms nothing');
  assert.equal(ime.gate.pauseElapsed(1), null);
  const early = createGate({ now: () => 0 });
  early.grant();
  early.configure(KEY, 1);
  typeText(early, 'opis');
  early.blur();
  assert.equal(early.ready(), false, 'ready arms nothing for text typed before the user left');
  assert.equal(early.pauseElapsed(1), null);
  const keyless = createGate({ now: () => 0 });
  keyless.grant();
  keyless.ready();
  typeText(keyless, 'opis');
  keyless.blur();
  assert.deepEqual(keyless.configure(KEY, 9), { permit: null, arm: false }, 'the first key known arms nothing');
  assert.equal(keyless.configure(KEY, 10).permit, null, 'a newer revision sends nothing for it either');
});

test('searched text stays confirmed after focus loss, so a settings change made in another tab searches it once', () => {
  const { gate } = opened({ revision: 1 });
  typeText(gate, 'opis');
  assert.deepEqual(gate.pauseElapsed(1), { permit: 1, version: 1, cause: 'pause' });
  gate.blur();
  assert.deepEqual(gate.configure(KEY, 2), { permit: { permit: 2, version: 1, cause: 'settings' }, arm: false });
});

test('an input event that leaves the text unchanged is no new content: no new version, no second search', () => {
  const { gate } = opened();
  typeText(gate, 'opis');
  assert.deepEqual(gate.pauseElapsed(1), { permit: 1, version: 1, cause: 'pause' });
  assert.equal(typeText(gate, 'opis'), false, 'no pause for the same text');
  assert.equal(gate.state.version, 1);
  assert.equal(gate.pauseElapsed(1), null);
});
