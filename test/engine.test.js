import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, resolveBall, DELIVERIES, LINES, SHOTS, timingTier, newSeed } from '../public/js/engine.js';
import { chooseDelivery, chooseSwing } from '../public/js/ai.js';

test('resolveBall is deterministic for the same inputs', () => {
  for (let i = 0; i < 500; i++) {
    const d = { type: Object.keys(DELIVERIES)[i % 6], line: Object.keys(LINES)[i % 3] };
    const shots = [...Object.keys(SHOTS), 'leave'];
    const sw = { shot: shots[i % shots.length], err: (i % 9) * 30 - 120 };
    const seed = newSeed();
    assert.deepEqual(resolveBall(d, sw, seed), resolveBall(d, sw, seed));
  }
});

test('timing tiers', () => {
  assert.equal(timingTier(0), 0);
  assert.equal(timingTier(-60), 1);
  assert.equal(timingTier(120), 2);
  assert.equal(timingTier(190), 3);
  assert.equal(timingTier(400), 4);
  assert.equal(timingTier(null), 4);
});

test('perfect drive on a full off-line ball usually scores well', () => {
  let runs = 0;
  let outs = 0;
  for (let s = 1; s <= 1000; s++) {
    const r = resolveBall({ type: 'medium', line: 'off' }, { shot: 'drive', err: 0 }, s);
    runs += r.runs;
    if (r.out) outs++;
  }
  assert.equal(outs, 0);
  assert.ok(runs / 1000 > 3, `avg ${runs / 1000}`);
});

test('leaving a straight ball is dangerous, leaving outside off is safe', () => {
  let straightOuts = 0;
  let offOuts = 0;
  for (let s = 1; s <= 1000; s++) {
    if (resolveBall({ type: 'fast', line: 'middle' }, { shot: 'leave', err: null }, s).out) straightOuts++;
    if (resolveBall({ type: 'fast', line: 'off' }, { shot: 'leave', err: null }, s).out) offOuts++;
  }
  assert.ok(straightOuts > 500);
  assert.equal(offOuts, 0);
});

test('unknown shots are treated as a leave', () => {
  const r = resolveBall({ type: 'fast', line: 'off' }, { shot: 'hack', err: 0 }, 7);
  assert.equal(r.kind, 'leave');
});

test('chasing side wins by wickets when it passes the target', () => {
  const m = new Match({ overs: 1, wickets: 2, firstBat: 0 }, ['A', 'B']);
  for (let i = 0; i < 6; i++) m.applyBall({ runs: 1, out: null });
  assert.equal(m.cur, 1);
  assert.equal(m.target, 7);
  assert.equal(m.applyBall({ runs: 6, out: null }), 'ball');
  assert.equal(m.applyBall({ runs: 1, out: null }), 'match');
  assert.equal(m.result.winner, 1);
  assert.match(m.result.text, /B won by 2 wickets/);
});

test('innings ends on wickets; defending side wins by runs', () => {
  const m = new Match({ overs: 2, wickets: 1, firstBat: 1 }, ['A', 'B']);
  m.applyBall({ runs: 4, out: null });
  assert.equal(m.applyBall({ runs: 0, out: 'bowled' }), 'innings');
  assert.equal(m.battingSide, 0);
  m.applyBall({ runs: 1, out: null });
  assert.equal(m.applyBall({ runs: 0, out: 'caught' }), 'match');
  assert.match(m.result.text, /B won by 3 runs/);
});

test('CPU vs CPU full matches always finish with identical state on both sides', () => {
  for (let g = 0; g < 200; g++) {
    const cfg = { overs: 1 + (g % 5), wickets: 1 + (g % 4), firstBat: g % 2 };
    const a = new Match(cfg, ['A', 'B']);
    const b = new Match(cfg, ['A', 'B']);
    let guard = 0;
    while (!a.over && guard++ < 1000) {
      const d = chooseDelivery('medium', a);
      const sw = chooseSwing(d, 'medium');
      const seed = newSeed();
      // each side resolves independently, like two networked peers
      a.applyBall(resolveBall(d, sw, seed));
      b.applyBall(resolveBall(d, sw, seed));
    }
    assert.ok(a.over);
    assert.deepEqual(a.innings, b.innings);
    assert.deepEqual(a.result, b.result);
  }
});
