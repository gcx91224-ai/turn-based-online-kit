/* =============================================================================
 * 可选模块测试：名册（好友 / 分数 / 排行）与匹配队列
 *
 * 和 room.test.mjs 一样，用假 DO 环境直接驱动，不需要 Cloudflare。
 * ========================================================================== */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, makeCtx, FakeSocket } from './helpers.mjs';
import { isValidCode } from '../worker/protocol.js';

installGlobals();
const { Players } = await import('../extras/players.js');
const { Ladder } = await import('../extras/ladder.js');

const T1 = 'player-aaaa-1111';
const T2 = 'player-bbbb-2222';
const T3 = 'player-cccc-3333';
const T4 = 'player-dddd-4444';

async function newPlayers() {
  const ctx = makeCtx();
  const p = new Players(ctx, {});
  await ctx.ready;
  return { ctx, p };
}

async function newLadder() {
  const ctx = makeCtx();
  const l = new Ladder(ctx, {});
  await ctx.ready;
  return { ctx, l };
}

/* ------------------------------------------------------------ 名册：身份 */

test('报到即建档，返回短号与初始分', async () => {
  const { p } = await newPlayers();
  const res = await (await p.seen({ token: T1, name: '阿A' })).json();

  assert.equal(res.ok, true);
  assert.equal(res.profile.id, T1.slice(0, 8));
  assert.equal(res.profile.rate.r, 1200);
  assert.equal(res.profile.rate.games, 0);
});

test('公开资料里永远没有完整 token', async () => {
  const { p } = await newPlayers();
  await p.seen({ token: T1, name: '阿A' });
  const prof = p.publicProfile(T1);

  assert.equal(JSON.stringify(prof).includes(T1), false);
  assert.equal(prof.id, T1.slice(0, 8));
});

test('短号有歧义时拒绝解析（绝不猜）', async () => {
  const { p } = await newPlayers();
  await p.seen({ token: 'samepref-aaaa', name: '甲' });
  await p.seen({ token: 'samepref-bbbb', name: '乙' });

  assert.equal(p.resolve('samepref'), null, '两个人都以 samepref 开头，不能猜是哪个');
  assert.equal(p.resolve('samepref-aaaa'), 'samepref-aaaa');
});

/* ------------------------------------------------------------ 名册：好友 */

test('加好友 → 对方收到请求 → 同意 → 双向都在列表里', async () => {
  const { p } = await newPlayers();
  await p.seen({ token: T1, name: '阿A' });
  await p.seen({ token: T2, name: '阿B' });

  await p.friendRequest({ token: T1, to: T2 });

  const bList = await (await p.friendList(T2)).json();
  assert.equal(bList.incoming.length, 1);
  assert.equal(bList.incoming[0].id, T1.slice(0, 8));
  assert.equal(JSON.stringify(bList).includes(T1), false, '不能把对方完整 token 发给客户端');

  await p.friendAccept({ token: T2, from: bList.incoming[0].id });

  const a2 = await (await p.friendList(T1)).json();
  const b2 = await (await p.friendList(T2)).json();
  assert.equal(a2.friends.length, 1);
  assert.equal(b2.friends.length, 1);
  assert.equal(a2.incoming.length, 0);
  assert.equal(b2.incoming.length, 0);
});

test('连点五次加好友，对方只收到一条请求', async () => {
  const { p } = await newPlayers();
  await p.seen({ token: T1, name: '阿A' });
  await p.seen({ token: T2, name: '阿B' });

  for (let i = 0; i < 5; i++) await p.friendRequest({ token: T1, to: T2 });
  const list = await (await p.friendList(T2)).json();
  assert.equal(list.incoming.length, 1);
});

test('互相加好友 → 直接成为好友，不会卡两条互等的请求', async () => {
  const { p } = await newPlayers();
  await p.seen({ token: T1, name: '阿A' });
  await p.seen({ token: T2, name: '阿B' });

  await p.friendRequest({ token: T1, to: T2 });
  const r = await (await p.friendRequest({ token: T2, to: T1 })).json();

  assert.equal(r.ok, true);
  assert.equal(r.mutual, true);

  const a = await (await p.friendList(T1)).json();
  const b = await (await p.friendList(T2)).json();
  assert.equal(a.friends.length, 1);
  assert.equal(b.friends.length, 1);
  assert.equal(a.incoming.length, 0);
  assert.equal(b.incoming.length, 0);
});

test('不能加自己', async () => {
  const { p } = await newPlayers();
  await p.seen({ token: T1, name: '阿A' });
  const res = await (await p.friendRequest({ token: T1, to: T1 })).json();
  assert.equal(res.ok, false);
});

test('删除好友是双向的', async () => {
  const { p } = await newPlayers();
  await p.seen({ token: T1, name: '阿A' });
  await p.seen({ token: T2, name: '阿B' });
  await p.friendRequest({ token: T1, to: T2 });
  await p.friendAccept({ token: T2, from: T1.slice(0, 8) });

  await p.friendRemove({ token: T1, friend: T2 });

  const a = await (await p.friendList(T1)).json();
  const b = await (await p.friendList(T2)).json();
  assert.equal(a.friends.length, 0);
  assert.equal(b.friends.length, 0);
});

test('在线状态来自心跳，不是「有没有连接」', async () => {
  const { p } = await newPlayers();
  await p.seen({ token: T1, name: '阿A' });

  assert.equal(p.publicProfile(T1).online, true);

  /* 把心跳时间往前推 60 秒（TTL 是 45 秒） */
  p.db.onlineAt[T1] = Date.now() - 60_000;
  assert.equal(p.publicProfile(T1).online, false);
});

/* ------------------------------------------------------- 名册：分数与排行 */

test('赢 +10 / 输 −10，分数不会掉到负数以下', async () => {
  const { p } = await newPlayers();
  await p.seen({ token: T1, name: '阿A' });

  let r = await (await p.applyResult({ token: T1, won: true })).json();
  assert.equal(r.rate.r, 1210);
  assert.equal(r.delta, 10);

  r = await (await p.applyResult({ token: T1, won: false })).json();
  assert.equal(r.rate.r, 1200);
  assert.equal(r.rate.games, 2);
  assert.equal(r.rate.w, 1);
  assert.equal(r.rate.l, 1);
});

test('没报到过的身份不写分（避免幽灵号）', async () => {
  const { p } = await newPlayers();
  const r = await (await p.applyResult({ token: 'never-seen-token', won: true })).json();
  assert.equal(r.ok, false);
  assert.equal(p.db.players['never-seen-token'], undefined);
});

test('排行榜：场次不够不上榜，且只输出短号', async () => {
  const { p } = await newPlayers();
  await p.seen({ token: T1, name: '老手' });
  await p.seen({ token: T2, name: '新手' });

  for (let i = 0; i < 10; i++) await p.applyResult({ token: T1, won: true });
  for (let i = 0; i < 3; i++) await p.applyResult({ token: T2, won: true });

  const board = await (await p.ladder(50)).json();
  assert.equal(board.rows.length, 1, '只打了 3 局的人不该上榜');
  assert.equal(board.rows[0].name, '老手');
  assert.equal(board.rows[0].r, 1300);
  assert.equal(JSON.stringify(board).includes(T1), false, '榜单不能泄漏完整 token');
});

/* ------------------------------------------------------------ 匹配队列 */

test('两个分数接近的人立刻配上，并拿到一个合法房间码', async () => {
  const { l } = await newLadder();
  const wsA = new FakeSocket();
  const wsB = new FakeSocket();

  await l.enqueue({ token: T1, name: '阿A', r: 1200 }, wsA);
  const res = await l.enqueue({ token: T2, name: '阿B', r: 1280 }, wsB);

  assert.equal(res.matched.length, 1);
  assert.equal(l.queue.length, 0);

  const a = wsA.messages.find((m) => m.type === 'matched');
  const b = wsB.messages.find((m) => m.type === 'matched');
  assert.ok(a && b);
  assert.equal(a.side, 'host');
  assert.equal(b.side, 'guest');
  assert.equal(a.code, b.code);
  assert.ok(isValidCode(a.code), '房间码不合法: ' + a.code);
});

test('分差太大不配；等超过 20 秒才放宽', async () => {
  const { l } = await newLadder();
  const wsC = new FakeSocket();
  const wsD = new FakeSocket();

  await l.enqueue({ token: T3, name: '低分', r: 1200 }, wsC);
  const res = await l.enqueue({ token: T4, name: '高分', r: 1700 }, wsD);
  assert.equal(res.matched.length, 0, '差 500 分不该立刻配');

  /* 模拟等了 25 秒 */
  for (const q of l.queue) q.at -= 25_000;
  const res2 = await l.tryMatch();
  assert.equal(res2.matched.length, 1, '等久了应该放宽到 600');
});

test('同一个 token 重复入队只占一个位置', async () => {
  const { l } = await newLadder();
  const ws1 = new FakeSocket();
  const ws2 = new FakeSocket();

  await l.enqueue({ token: T1, name: '阿A', r: 1200 }, ws1);
  await l.enqueue({ token: T1, name: '阿A', r: 1200 }, ws2);

  assert.equal(l.queue.length, 1);
});

test('取消排队', async () => {
  const { l } = await newLadder();
  await l.enqueue({ token: T1, name: '阿A', r: 1200 }, new FakeSocket());
  assert.equal(l.queue.length, 1);

  await l.cancel(T1);
  assert.equal(l.queue.length, 0);
});

test('排队超过 90 秒被清理，并收到 timeout', async () => {
  const { l } = await newLadder();
  const ws = new FakeSocket();
  await l.enqueue({ token: T1, name: '阿A', r: 1200 }, ws);

  l.queue[0].at -= 100_000;
  await l.sweep();

  assert.equal(l.queue.length, 0);
  assert.ok(ws.messages.some((m) => m.type === 'timeout'));
  assert.equal(ws.readyState, 3, '应该把连接关掉，别让用户对着转圈等一辈子');
});

test('队列会落盘（DO 重启后至少还知道谁在等）', async () => {
  const { ctx, l } = await newLadder();
  await l.enqueue({ token: T1, name: '阿A', r: 1200 }, new FakeSocket());

  const saved = await ctx.storage.get('queue');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].token, T1);
  assert.equal(saved[0].ws, undefined, 'socket 不能序列化，不该存进去');
});
