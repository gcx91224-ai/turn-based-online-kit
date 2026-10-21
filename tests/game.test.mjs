import test from 'node:test';
import assert from 'node:assert/strict';
import { MOVES, WIN_SCORE, isValidMove, resolve, randomMove } from '../worker/game.js';

test('规则表：三个动作都在', () => {
  assert.deepEqual(MOVES, ['rock', 'paper', 'scissors']);
  assert.equal(WIN_SCORE, 3);
});

test('resolve：九个组合全对', () => {
  const table = {
    'rock,rock': 'draw',
    'rock,paper': 'B',
    'rock,scissors': 'A',
    'paper,rock': 'A',
    'paper,paper': 'draw',
    'paper,scissors': 'B',
    'scissors,rock': 'B',
    'scissors,paper': 'A',
    'scissors,scissors': 'draw'
  };
  for (const [key, want] of Object.entries(table)) {
    const [a, b] = key.split(',');
    assert.equal(resolve(a, b), want, key + ' 应该是 ' + want);
  }
});

test('resolve：非法动作直接抛错（不要静默返回平局）', () => {
  assert.throws(() => resolve('rock', 'banana'));
  assert.throws(() => resolve(null, 'rock'));
});

test('isValidMove', () => {
  for (const m of MOVES) assert.equal(isValidMove(m), true);
  for (const m of ['', 'ROCK', 'gun', null, 0]) assert.equal(isValidMove(m), false);
});

test('randomMove 永远落在合法集合里', () => {
  for (let i = 0; i < 200; i++) assert.ok(MOVES.includes(randomMove()));
});
