import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBall, DELIVERIES, timingTier } from '../public/js/engine.js';
import { CHARACTERS, STATS, getChar, matchupMods, deliveryTime, movement } from '../public/js/characters.js';

test('roster is well-formed and balanced', () => {
  const ids = new Set();
  for (const c of CHARACTERS) {
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
    const total = Object.keys(STATS).reduce((s, k) => s + c.stats[k], 0);
    assert.equal(total, 12, `${c.id} has ${total} stat points`);
    for (const k of Object.keys(STATS)) assert.ok(c.stats[k] >= 1 && c.stats[k] <= 5);
  }
});

test('unknown character ids fall back safely', () => {
  assert.equal(getChar('nope').id, 'sparks');
  assert.equal(getChar(undefined).id, 'sparks');
});

test('an all-3 matchup is neutral', () => {
  const s = getChar('sparks');
  assert.deepEqual(matchupMods(s, s), { window: 1, power: 1 });
  assert.equal(deliveryTime('fast', s), DELIVERIES.fast.time);
  assert.equal(movement(s), 1);
});

test('stats move the numbers in the right direction', () => {
  const wall = getChar('rook'); // timing 5
  const thunder = getChar('thunder'); // power 5
  const silk = getChar('silk'); // craft 5
  const whip = getChar('whiplash'); // pace 5
  const s = getChar('sparks');
  assert.ok(matchupMods(wall, s).window > 1);
  assert.ok(matchupMods(s, silk).window < 1);
  assert.ok(matchupMods(thunder, s).power > 1);
  assert.ok(deliveryTime('fast', whip) < DELIVERIES.fast.time);
  assert.equal(deliveryTime('spin', whip), DELIVERIES.spin.time); // pace doesn't speed up spin
  // an 85ms-late shot is only "OK" normally but "Good" for a timing-5 batter
  assert.equal(timingTier(85), 2);
  assert.equal(timingTier(85, matchupMods(wall, s).window), 1);
});

test('power hitters score more boundaries on the same inputs', () => {
  const thunder = getChar('thunder');
  const weak = getChar('silk'); // power 1
  const s = getChar('sparks');
  let big = 0;
  let small = 0;
  for (let seed = 1; seed <= 2000; seed++) {
    const d = { type: 'medium', line: 'off' };
    const sw = { shot: 'drive', err: 60 };
    if (resolveBall(d, sw, seed, matchupMods(thunder, s)).runs >= 4) big++;
    if (resolveBall(d, sw, seed, matchupMods(weak, s)).runs >= 4) small++;
  }
  assert.ok(big > small * 1.2, `${big} vs ${small}`);
});

test('resolveBall stays deterministic with modifiers', () => {
  const mods = matchupMods(getChar('ace'), getChar('fox'));
  for (let seed = 1; seed < 300; seed++) {
    const d = { type: 'spin', line: 'leg' };
    const sw = { shot: 'loft', err: (seed % 11) * 20 - 100 };
    assert.deepEqual(resolveBall(d, sw, seed, mods), resolveBall(d, sw, seed, { ...mods }));
  }
});
