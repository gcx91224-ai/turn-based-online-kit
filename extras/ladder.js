/* =============================================================================
 * 匹配队列 Durable Object（可选模块）
 *
 * 全局单例。只干一件事：把两个分数接近、同时在等的人撮合到一起，
 * 然后给他们一个**普通房间码** —— 对局、重连、观战全部复用现有房间，
 * 不重写第二套对局系统。
 *
 * 撮合规则：
 *   分差 ≤ 300 就能配；等超过 20 秒放宽到 600
 *   取分差最小的一对；一样近就先配等得久的
 *   排队超过 90 秒自动退出
 *
 * ★ 这是可选模块，默认不部署。启用方式见 wrangler.jsonc。
 * ========================================================================== */

import { newRoomCode } from '../worker/protocol.js';

const NEAR = 300;
const WIDE = 600;
const WIDE_AFTER_MS = 20_000;
const EXPIRE_MS = 90_000;

function clampRating(v) {
  return Math.max(0, Math.min(9999, Number(v) || 1200));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export class Ladder {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queue = [];
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('queue');
      /* 只恢复了"人"，socket 无法序列化 —— 那些条目会在下一次 sweep 被摘掉。
         所以 DO 重启后，客户端必须自己重连并重新入队（前端本来就会重连）。 */
      if (Array.isArray(saved)) this.queue = saved.map((x) => ({ ...x, ws: null }));
    });
  }

  async persist() {
    await this.ctx.storage.put('queue', this.queue.map((q) => ({
      token: q.token, name: q.name, r: q.r, at: q.at
    })));
  }

  /* 清掉 socket 没了的、排队太久的 */
  async sweep(now = Date.now()) {
    const keep = [];
    for (const q of this.queue) {
      const expired = now - q.at > EXPIRE_MS;
      if (!q.ws || expired) {
        if (q.ws) {
          try {
            q.ws.send(JSON.stringify({ type: 'timeout' }));
            q.ws.close();
          } catch { /* 断了算了 */ }
        }
        continue;
      }
      keep.push(q);
    }
    if (keep.length !== this.queue.length) {
      this.queue = keep;
      await this.persist();
    }
  }

  async enqueue(entry, ws) {
    const token = String(entry.token || '').slice(0, 64);
    if (!token) return { ok: false, error: '缺少 token' };
    if (!ws) return { ok: false, error: '必须用 WebSocket 排队' };

    const rec = {
      token,
      name: String(entry.name || '玩家').slice(0, 24),
      r: clampRating(entry.r),
      at: Date.now(),
      ws
    };
    /* 同一个 token 重复入队 = 更新分数，不是排两次 */
    const i = this.queue.findIndex((q) => q.token === token);
    if (i >= 0) this.queue[i] = rec;
    else this.queue.push(rec);

    await this.persist();
    return this.tryMatch();
  }

  async cancel(token) {
    const t = String(token || '').slice(0, 64);
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.token !== t);
    if (this.queue.length !== before) {
      await this.persist();
      this.notifyWaiting();
    }
    return { ok: true, waiting: this.queue.length };
  }

  notifyWaiting() {
    for (const q of this.queue) {
      try {
        q.ws.send(JSON.stringify({ type: 'waiting', n: this.queue.length }));
      } catch { /* 断了算了 */ }
    }
  }

  async tryMatch() {
    await this.sweep();

    const matched = [];
    for (;;) {
      const now = Date.now();
      let best = null;

      for (let i = 0; i < this.queue.length; i++) {
        for (let j = i + 1; j < this.queue.length; j++) {
          const a = this.queue[i];
          const b = this.queue[j];
          if (a.token === b.token) continue;    // 同一人开了两个窗口，别自己配自己

          const gap = Math.abs(a.r - b.r);
          const waited = now - Math.min(a.at, b.at);
          const limit = waited > WIDE_AFTER_MS ? WIDE : NEAR;
          if (gap > limit) continue;

          if (!best || gap < best.gap || (gap === best.gap && waited > best.waited)) {
            best = { i, j, gap, waited };
          }
        }
      }

      if (!best) break;

      const a = this.queue[best.i];
      const b = this.queue[best.j];
      const code = newRoomCode();

      /* 先摘后面的下标，免得串位 */
      for (const idx of [best.i, best.j].sort((x, y) => y - x)) this.queue.splice(idx, 1);

      /* ★ 直接用摘下来的引用发消息。
         不要拿 token 回队列里查 —— 人已经不在队列里了，
         查不到就等于"配上了但谁都不知道"。 */
      const tell = (rec, msg) => {
        try { rec.ws.send(JSON.stringify(msg)); } catch { /* 断了算了 */ }
      };
      tell(a, { type: 'matched', code, side: 'host', opp: { name: b.name, r: b.r } });
      tell(b, { type: 'matched', code, side: 'guest', opp: { name: a.name, r: a.r } });

      matched.push({ a: a.token, b: b.token, code });
    }

    await this.persist();
    if (matched.length) this.notifyWaiting();
    return { ok: true, matched, waiting: this.queue.length };
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ token: String(url.searchParams.get('token') || '').slice(0, 64) });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname.endsWith('/status')) {
      await this.sweep();
      return json({
        ok: true,
        waiting: this.queue.length,
        queue: this.queue.map((q) => ({ name: q.name, r: q.r, at: q.at }))
      });
    }

    if (url.pathname.endsWith('/cancel')) {
      let body = {};
      try { body = await request.json(); } catch { /* 空 body 也行 */ }
      return json(await this.cancel(body.token));
    }

    return new Response('匹配队列在线', { status: 200 });
  }

  async webSocketMessage(ws, raw) {
    let msg = null;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    const at = ws.deserializeAttachment() || {};
    const token = String(msg.token || at.token || '').slice(0, 64);

    if (msg.type === 'queue') {
      const r = await this.enqueue({ token, name: msg.name, r: msg.r }, ws);
      try {
        ws.send(JSON.stringify({ type: 'queued', waiting: r.waiting || 0 }));
      } catch { /* 断了算了 */ }
      this.notifyWaiting();
      return;
    }

    if (msg.type === 'cancel') {
      await this.cancel(token);
      try { ws.send(JSON.stringify({ type: 'cancelled' })); } catch { /* 断了算了 */ }
      return;
    }

    if (msg.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong' })); } catch { /* 断了算了 */ }
    }
  }

  async webSocketClose(ws) {
    const at = ws.deserializeAttachment() || {};
    if (at.token) await this.cancel(at.token);
  }

  async webSocketError(ws) {
    const at = ws.deserializeAttachment() || {};
    if (at.token) await this.cancel(at.token);
  }
}
