/* =============================================================================
 * 房间逻辑测试：真跑 worker/room.js，只是把 Cloudflare 的环境换成了桩。
 *
 * 这就是「没有本地 runtime 也能测服务端」的做法：
 * 不启动 workerd、不连网络，直接调 DO 的消息处理器。
 * ========================================================================== */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals, makeCtx, wsRequest, statusRequest, drop } from './helpers.mjs';

installGlobals();
const { Room } = await import('../worker/room.js');

const CODE = 'AB3CD';
const P1 = 'token-aaaa-1111';
const P2 = 'token-bbbb-2222';
const P3 = 'token-cccc-3333';

async function newRoom() {
  const ctx = makeCtx();
  const room = new Room(ctx, {});
  await ctx.ready;
  return { ctx, room };
}

async function join(room, ctx, token, name) {
  const before = ctx.getWebSockets().length;
  const res = await room.fetch(wsRequest(CODE, token, name));
  const sockets = ctx.getWebSockets();
  return { res, ws: sockets[sockets.length - 1], added: sockets.length > before };
}

async function pick(room, ws, move) {
  await room.webSocketMessage(ws, JSON.stringify({ type: 'pick', move }));
}

test('第一个人进来：分配 A 座，等对手', async () => {
  const { ctx, room } = await newRoom();
  const a = await join(room, ctx, P1, '阿A');

  assert.equal(a.res.status, 101);
  assert.equal(a.ws.attachment.seat, 'A');
  const view = a.ws.last();
  assert.equal(view.type, 'state');
  assert.equal(view.phase, 'waiting');
  assert.equal(view.players.A.you, true);
  assert.equal(view.players.B.joined, false);
});

test('第二个人进来：自动开局，两人都收到 playing', async () => {
  const { ctx, room } = await newRoom();
  const a = await join(room, ctx, P1, '阿A');
  const b = await join(room, ctx, P2, '阿B');

  assert.equal(b.ws.attachment.seat, 'B');
  assert.equal(b.ws.last().phase, 'playing');
  assert.equal(a.ws.last().phase, 'playing');
  assert.equal(a.ws.last().round, 1);
  assert.equal(a.ws.last().winScore, 3);
});

test('★ 视图裁剪：对方还没出时，绝不把动作发给我', async () => {
  const { ctx, room } = await newRoom();
  const a = await join(room, ctx, P1, '阿A');
  const b = await join(room, ctx, P2, '阿B');
  b.ws.clear();

  await pick(room, a.ws, 'rock');

  const view = b.ws.last();
  assert.equal(view.oppReady, true, '应该告诉对手「我已经出了」');
  assert.equal(view.myPick, null, '我自己还没出');
  assert.ok(
    !JSON.stringify(view).includes('rock'),
    '对方未公开的动作泄漏进了我的视图：' + JSON.stringify(view)
  );
});

test('★ 只认第一条动作：先 rock 再 paper，仍按 rock 结算', async () => {
  const { ctx, room } = await newRoom();
  const a = await join(room, ctx, P1, '阿A');
  const b = await join(room, ctx, P2, '阿B');

  await pick(room, a.ws, 'rock');
  await pick(room, a.ws, 'paper');     // 想改？不认
  await pick(room, b.ws, 'scissors');

  const view = a.ws.last();
  assert.equal(view.lastResult.picks.A, 'rock');
  assert.equal(view.lastResult.winner, 'A');
  assert.deepEqual(view.score, { A: 1, B: 0 });
});

test('结算：平局不加分，回合前进', async () => {
  const { ctx, room } = await newRoom();
  const a = await join(room, ctx, P1, '阿A');
  const b = await join(room, ctx, P2, '阿B');

  await pick(room, a.ws, 'paper');
  await pick(room, b.ws, 'paper');

  const view = a.ws.last();
  assert.equal(view.lastResult.winner, 'draw');
  assert.deepEqual(view.score, { A: 0, B: 0 });
  assert.equal(view.round, 2, '平局也要进下一回合');
  assert.equal(view.myPick, null, '新回合自己的动作要清空');
});

test('先到 3 分结束，并撤掉超时闹钟', async () => {
  const { ctx, room } = await newRoom();
  const a = await join(room, ctx, P1, '阿A');
  const b = await join(room, ctx, P2, '阿B');

  for (let i = 0; i < 3; i++) {
    await pick(room, a.ws, 'rock');
    await pick(room, b.ws, 'scissors');
  }

  const view = b.ws.last();
  assert.equal(view.phase, 'over');
  assert.equal(view.winner, 'A');
  assert.deepEqual(view.score, { A: 3, B: 0 });
  assert.equal(ctx.alarmAt, null, '结束后不该再留超时闹钟');
});

test('再来一局：两人都点才重开', async () => {
  const { ctx, room } = await newRoom();
  const a = await join(room, ctx, P1, '阿A');
  const b = await join(room, ctx, P2, '阿B');

  for (let i = 0; i < 3; i++) {
    await pick(room, a.ws, 'rock');
    await pick(room, b.ws, 'scissors');
  }

  await room.webSocketMessage(a.ws, JSON.stringify({ type: 'again' }));
  assert.equal(b.ws.last().phase, 'over', '只有一个人点，不能重开');
  assert.equal(b.ws.last().again.opp, true, '要告诉对方「他已经同意了」');

  await room.webSocketMessage(b.ws, JSON.stringify({ type: 'again' }));
  const view = a.ws.last();
  assert.equal(view.phase, 'playing');
  assert.equal(view.round, 1);
  assert.deepEqual(view.score, { A: 0, B: 0 });
});

test('满员：第三个人进不来（409）', async () => {
  const { ctx, room } = await newRoom();
  await join(room, ctx, P1, '阿A');
  await join(room, ctx, P2, '阿B');

  const c = await join(room, ctx, P3, '阿C');
  assert.equal(c.res.status, 409);
  assert.equal(c.added, false);
  const body = await c.res.json();
  assert.equal(body.code, 'ROOM_FULL');
});

test('超时：没出的人由服务器补一个，回合照常结算', async () => {
  const { ctx, room } = await newRoom();
  const a = await join(room, ctx, P1, '阿A');
  await join(room, ctx, P2, '阿B');

  await pick(room, a.ws, 'rock');
  assert.equal(a.ws.last().lastResult, null, '只有一个人出，还没结算');

  await room.alarm();

  const view = a.ws.last();
  assert.ok(view.lastResult, '超时后必须结算');
  assert.equal(view.lastResult.picks.A, 'rock');
  assert.ok(['rock', 'paper', 'scissors'].includes(view.lastResult.picks.B));
});

test('重连：同一个 token 坐回原座位，不会变成第三个人', async () => {
  const { ctx, room } = await newRoom();
  const a1 = await join(room, ctx, P1, '阿A');
  await join(room, ctx, P2, '阿B');

  drop(ctx, a1.ws);                       // 刷新页面
  const a2 = await join(room, ctx, P1, '阿A');

  assert.equal(a2.ws.attachment.seat, 'A');
  assert.equal(a2.ws.last().players.A.name, '阿A');
  assert.equal(a2.ws.last().players.B.joined, true);
  assert.equal(a2.ws.last().phase, 'playing');
});

test('房间状态会落盘（DO 被唤醒后还能接着打）', async () => {
  const { ctx, room } = await newRoom();
  await join(room, ctx, P1, '阿A');
  await join(room, ctx, P2, '阿B');

  const saved = await ctx.peek();
  assert.ok(saved, '状态应该写进 storage');
  assert.equal(saved.phase, 'playing');
  assert.equal(saved.seats.A.name, '阿A');
  assert.equal(saved.seats.B.name, '阿B');
});

test('非法 token 被拒（400）', async () => {
  const { ctx, room } = await newRoom();
  const bad = await room.fetch(wsRequest(CODE, 'x', '阿A'));
  assert.equal(bad.status, 400);
  assert.equal(ctx.getWebSockets().length, 0);
});

test('状态查询：没人时 occupied=false，有人时给人数与阶段', async () => {
  const { ctx, room } = await newRoom();

  const empty = await (await room.fetch(statusRequest(CODE))).json();
  assert.equal(empty.room.occupied, false);

  await join(room, ctx, P1, '阿A');
  const one = await (await room.fetch(statusRequest(CODE))).json();
  assert.equal(one.room.occupied, true);
  assert.equal(one.room.players, 1);
  assert.equal(one.room.phase, 'waiting');

  await join(room, ctx, P2, '阿B');
  const two = await (await room.fetch(statusRequest(CODE))).json();
  assert.equal(two.room.players, 2);
  assert.equal(two.room.phase, 'playing');
});

test('乱发的消息不会把房间搞崩', async () => {
  const { ctx, room } = await newRoom();
  const a = await join(room, ctx, P1, '阿A');
  await join(room, ctx, P2, '阿B');

  await room.webSocketMessage(a.ws, 'not json');
  await room.webSocketMessage(a.ws, JSON.stringify({ type: 'pick', move: 'banana' }));
  await room.webSocketMessage(a.ws, JSON.stringify({ type: 'unknown' }));
  await room.webSocketMessage(a.ws, JSON.stringify({ type: 'again' }));   // 还没结束，忽略

  const view = a.ws.last();
  assert.equal(view.phase, 'playing');
  assert.equal(view.myPick, null);
});
