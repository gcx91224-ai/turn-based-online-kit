import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALPHABET, CODE_LEN, newRoomCode, normalizeCode, isValidCode, sanitizeName, isValidToken
} from '../worker/protocol.js';

test('房间码：长度与字符集', () => {
  for (let i = 0; i < 500; i++) {
    const code = newRoomCode();
    assert.equal(code.length, CODE_LEN);
    for (const ch of code) assert.ok(ALPHABET.includes(ch), code + ' 里有非法字符 ' + ch);
  }
});

test('房间码：不包含容易看错的字符', () => {
  const banned = ['0', 'O', '1', 'I', 'L'];
  for (let i = 0; i < 200; i++) {
    const code = newRoomCode();
    for (const ch of banned) assert.ok(!code.includes(ch), code + ' 含 ' + ch);
  }
});

test('房间码：500 次不重复（撞码概率极低，但不是 0）', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(newRoomCode());
  assert.ok(seen.size > 495, '重复太多，随机源可能有问题');
});

test('normalizeCode：去空白 + 转大写', () => {
  assert.equal(normalizeCode('  ab3cd '), 'AB3CD');
  assert.equal(normalizeCode('AB3CD'), 'AB3CD');
  assert.equal(normalizeCode(null), '');
  assert.equal(normalizeCode(123), '');
});

test('isValidCode：拒绝长度不对/非法字符', () => {
  assert.equal(isValidCode('AB3CD'), true);
  assert.equal(isValidCode(' ab3cd '), true);
  assert.equal(isValidCode('AB3C'), false);
  assert.equal(isValidCode('AB3CDE'), false);
  assert.equal(isValidCode('AB0CD'), false);   // 0 不在字母表里
  assert.equal(isValidCode('ABICD'), false);   // I 不在字母表里
  assert.equal(isValidCode('AB-CD'), false);
  assert.equal(isValidCode(''), false);
});

test('sanitizeName：截断、去空白、空值兜底', () => {
  assert.equal(sanitizeName('  老王  '), '老王');
  assert.equal(sanitizeName(''), '玩家');
  assert.equal(sanitizeName(null), '玩家');
  assert.equal(sanitizeName('一二三四五六七八九十一二三四五六七八'), '一二三四五六七八九十一二三四五六');
});

test('isValidToken：只认 8-64 位安全字符', () => {
  assert.equal(isValidToken('abcdef12'), true);
  assert.equal(isValidToken('550e8400-e29b-41d4-a716-446655440000'), true);
  assert.equal(isValidToken('abc_def-123'), true);
  assert.equal(isValidToken('short'), false);
  assert.equal(isValidToken('has space here'), false);
  assert.equal(isValidToken('x'.repeat(65)), false);
  assert.equal(isValidToken(null), false);
});
