/* =============================================================================
 * 房间 Durable Object
 *
 * 一个房间 = 一个 DO 实例。它负责：
 *   座位        谁坐 A、谁坐 B（用设备 token 认人，刷新/断线还能回来）
 *   回合        两人都出拳 → 结算 → 下一回合
 *   超时        30 秒没出，服务器替他随机出一个（用 DO alarm，休眠后仍然会触发）
 *   视图裁剪    ★ 绝不能把「对方还没出的那一手」发给客户端
 *   再来一局    两人都点才重开
 *
 * 服务器是**权威**的：它保存动作、算结果。客户端只是显示器。
 * 如果你想反过来（服务器不懂规则、只转发操作），看 docs/04-fair-play.md 的锁步方案。
 * ========================================================================== */

import { normalizeCode, isValidCode, sanitizeName, isValidToken } from './protocol.js';
import { isValidMove, resolve, randomMove, WIN_SCORE } from './game.js';

const TURN_MS = 30_000;
const STORAGE_KEY = 'room';
/* 座位是房间的概念，不是游戏规则的概念。
   想扩到 3-4 人：这里加 C/D，再把 game.js 的 resolve 改成收整个 picks 对象。 */
const SEATS = ['A', 'B'];

function other(seat) {
  return seat === 'A' ? 'B' : 'A';
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.state = null;
    /* DO 可能被休眠/重启，内存态会丢。构造时先把落盘的那份读回来。 */
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get(STORAGE_KEY)) || null;
    });
  }

  async load() {
    if (!this.state) this.state = (await this.ctx.storage.get(STORAGE_KEY)) || null;
    return this.state;
  }

  async save() {
    if (this.state) await this.ctx.storage.put(STORAGE_KEY, this.state);
  }

  blank(code) {
    return {
      code,
      seats: { A: null, B: null },        // { token, name }
      phase: 'waiting',                   // waiting | playing | over
      round: 1,
      score: { A: 0, B: 0 },
      picks: { A: null, B: null },        // ★ 只在服务器内存/存储里，绝不原样广播
      lastResult: null,                   // 已结算的一轮，可以公开
      winner: null,
      again: { A: false, B: false }
    };
  }

  seatOfToken(state, token) {
    for (const s of SEATS) {
      const p = state.seats[s];
      if (p && p.token === token) return s;
    }
    return null;
  }

  freeSeat(state) {
    for (const s of SEATS) if (!state.seats[s]) return s;
    return null;
  }

  /* 在线 = 这个座位此刻有活着的 WebSocket。不用额外存字段，
     否则刷新页面时会闪一下「离线」再变「在线」。 */
  isOnline(seat) {
    for (const ws of this.ctx.getWebSockets()) {
      const at = safeAttachment(ws);
      if (at && at.seat === seat) return true;
    }
    return false;
  }

  summary() {
    const st = this.state;
    if (!st) return { occupied: false };
    return {
      occupied: true,
      phase: st.phase,
      players: SEATS.filter((s) => st.seats[s]).length,
      round: st.round
    };
  }

  /* ---------------------------------------------------------------- 连接 */

  async fetch(request) {
    const url = new URL(request.url);
    const code = normalizeCode(url.searchParams.get('room'));

    if (!isValidCode(code)) return json({ ok: false, error: '房间码不合法' }, 400);

    /* 非 WebSocket：房间状态查询（建房查重、房间列表都用它） */
    if (request.headers.get('Upgrade') !== 'websocket') {
      await this.load();
      return json({ ok: true, room: this.summary() });
    }

    const token = url.searchParams.get('token');
    const name = sanitizeName(url.searchParams.get('name'));
    if (!isValidToken(token)) return json({ ok: false, error: 'token 不合法' }, 400);

    let st = await this.load();
    if (!st) {
      st = this.blank(code);
      this.state = st;
    }

    let seat = this.seatOfToken(st, token);
    if (!seat) {
      seat = this.freeSeat(st);
      if (!seat) return json({ ok: false, error: '房间已满', code: 'ROOM_FULL' }, 409);
      st.seats[seat] = { token, name };
    } else if (st.seats[seat].name !== name) {
      /* 换了昵称：只更新显示名，座位与 token 不变 */
      st.seats[seat].name = name;
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    /* Hibernation API：连接可以「睡着」而不占内存，DO 被唤醒后照样能收到消息。
       用 server.accept() 也行，但那样 DO 不会休眠，白烧额度。 */
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ seat, token });

    await this.maybeStart();
    await this.save();
    this.broadcast();

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ------------------------------------------------------------ 回合流转 */

  async maybeStart() {
    const st = this.state;
    if (!st || st.phase !== 'waiting') return;
    if (!st.seats.A || !st.seats.B) return;

    st.phase = 'playing';
    st.round = 1;
    st.score = { A: 0, B: 0 };
    st.picks = { A: null, B: null };
    st.lastResult = null;
    st.winner = null;
    st.again = { A: false, B: false };

    await this.armTimer();
  }

  async armTimer() {
    await this.ctx.storage.setAlarm(Date.now() + TURN_MS);
  }

  /* 一轮结束：算分、写 lastResult、决定是下一轮还是整局结束 */
  async settle() {
    const st = this.state;
    const a = st.picks.A;
    const b = st.picks.B;
    st.picks = { A: null, B: null };

    const r = resolve(a, b);
    if (r === 'A') st.score.A += 1;
    else if (r === 'B') st.score.B += 1;

    st.lastResult = { round: st.round, picks: { A: a, B: b }, winner: r };

    if (st.score.A >= WIN_SCORE || st.score.B >= WIN_SCORE) {
      st.phase = 'over';
      st.winner = st.score.A > st.score.B ? 'A' : 'B';
      await this.ctx.storage.deleteAlarm();     // 结束了就别再触发超时
    } else {
      st.round += 1;
      await this.armTimer();
    }
    await this.save();
  }

  async restart() {
    const st = this.state;
    st.phase = 'waiting';
    st.round = 1;
    st.score = { A: 0, B: 0 };
    st.picks = { A: null, B: null };
    st.lastResult = null;
    st.winner = null;
    st.again = { A: false, B: false };
    await this.maybeStart();
    await this.save();
  }

  /* 超时：谁没出就给谁随机补一个。DO alarm 在休眠后仍然会触发。 */
  async alarm() {
    const st = await this.load();
    if (!st || st.phase !== 'playing') return;
    if (!st.picks.A) st.picks.A = randomMove();
    if (!st.picks.B) st.picks.B = randomMove();
    await this.settle();
    this.broadcast();
  }

  /* -------------------------------------------------------------- 消息 */

  async webSocketMessage(ws, raw) {
    let msg = null;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    const at = safeAttachment(ws);
    if (!at || !at.seat) return;
    const seat = at.seat;

    if (msg.type === 'ping') {
      try {
        ws.send(JSON.stringify({ type: 'pong' }));
      } catch {
        /* 断了就算了 */
      }
      return;
    }

    const st = await this.load();
    if (!st) return;

    if (msg.type === 'pick') {
      if (st.phase !== 'playing') return;
      if (!isValidMove(msg.move)) return;
      /* ★ 只认第一条。否则客户端可以先发一个、等看到对方没出再改 —— 
         这就是「后手偷看」，同时出招的游戏里最经典的作弊方式。 */
      if (st.picks[seat]) return;

      st.picks[seat] = msg.move;

      if (st.picks.A && st.picks.B) await this.settle();
      else await this.save();

      this.broadcast();
      return;
    }

    if (msg.type === 'again') {
      if (st.phase !== 'over') return;
      st.again[seat] = true;
      if (st.again.A && st.again.B) await this.restart();
      else await this.save();
      this.broadcast();
      return;
    }
  }

  async webSocketClose(ws) {
    /* 座位不释放：token 还在，刷新或重连能坐回原位。
       释放座位要等房间被清理，或者你自己加一个「离席」消息。 */
    this.broadcast();
  }

  async webSocketError(ws) {
    this.broadcast();
  }

  /* -------------------------------------------------------------- 广播 */

  /* ★ 每个座位拿到的视图不一样：自己的 pick 可以给，对方的只给「出没出」。
     如果这里直接把 this.state 发出去，对方还没出的那一手就泄漏了。 */
  viewFor(seat) {
    const st = this.state;
    const opp = other(seat);
    const players = {};
    for (const s of SEATS) {
      const p = st.seats[s];
      players[s] = {
        joined: !!p,
        name: p ? p.name : null,
        online: this.isOnline(s),
        you: s === seat
      };
    }
    return {
      type: 'state',
      code: st.code,
      phase: st.phase,
      round: st.round,
      score: { ...st.score },
      winScore: WIN_SCORE,
      you: seat,
      players,
      myPick: st.picks[seat] || null,
      oppReady: !!st.picks[opp],
      lastResult: st.lastResult,
      winner: st.winner,
      again: { you: !!st.again[seat], opp: !!st.again[opp] }
    };
  }

  broadcast() {
    if (!this.state) return;
    for (const ws of this.ctx.getWebSockets()) {
      const at = safeAttachment(ws);
      if (!at || !at.seat) continue;
      try {
        ws.send(JSON.stringify(this.viewFor(at.seat)));
      } catch {
        /* 单个连接坏了不影响其他人 */
      }
    }
  }
}

function safeAttachment(ws) {
  try {
    return ws.deserializeAttachment ? ws.deserializeAttachment() : null;
  } catch {
    return null;
  }
}
