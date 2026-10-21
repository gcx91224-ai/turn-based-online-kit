/* =============================================================================
 * 全局名册 Durable Object（可选模块）
 *
 * 干什么：
 *   按设备 token 认人 → 昵称/头像/在线状态
 *   好友关系（双向表 + 入站请求队列）
 *   排位分（固定 ±10）与排行榜（只输出短号）
 *
 * ★ 这不是默认部署的一部分。要启用见 wrangler.jsonc 里的注释：
 *   加 binding + 一条新 migration，然后在 worker/index.js 里加路由。
 *
 * ★ 和房间的关系：房间只负责"这一局"，这里负责"这个人"。
 *   任何跨房间持久化的东西都必须用设备 token，不能用座位令牌（见 docs/10）。
 * ========================================================================== */

const START_RATING = 1200;
const WIN_DELTA = 10;
const MIN_GAMES_FOR_BOARD = 10;   // 打够多少局才进榜
const ONLINE_TTL = 45_000;        // 心跳 20 秒，留一次丢失的余量
const MAX_FRIENDS = 100;
const MAX_REQUESTS = 20;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function normToken(t) {
  const s = String(t || '').slice(0, 64);
  return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : '';
}

function nameOf(s) {
  return String(s || '').trim().slice(0, 24) || '玩家';
}

export class Players {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.db = { players: {}, friends: {}, requests: {}, onlineAt: {} };
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('db');
      if (saved) this.db = { ...this.db, ...saved };
    });
  }

  async save() {
    await this.ctx.storage.put('db', this.db);
  }

  /* ------------------------------------------------------------ 身份 */

  short(token) {
    return String(token).slice(0, 8);
  }

  /* 短号或完整 token → 完整 token。
     短号撞了（前缀匹配到多个）就返回 null，绝不猜。 */
  resolve(key) {
    const k = String(key || '');
    if (!k) return null;
    if (this.db.players[k]) return k;
    const hits = Object.keys(this.db.players).filter((t) => t.startsWith(k));
    return hits.length === 1 ? hits[0] : null;
  }

  isOnline(token) {
    return (this.db.onlineAt[token] || 0) > Date.now() - ONLINE_TTL;
  }

  publicProfile(token) {
    const p = this.db.players[token];
    if (!p) return null;
    const r = p.rate;
    return {
      id: this.short(token),
      name: p.name,
      avatar: p.avatar || null,
      online: this.isOnline(token),
      rate: {
        r: r ? r.r : START_RATING,
        w: r ? r.w : 0,
        l: r ? r.l : 0,
        games: r ? r.games : 0,
        best: r ? r.best : START_RATING
      }
    };
  }

  /* 心跳：建档 / 刷新在线时间 / 顺手更新"在哪个房间"
     ★ 真实规模下这里要节流（比如 10 秒内的重复心跳不落盘），
       否则每个在线玩家每 20 秒写一次 SQLite。朋友局无所谓。 */
  async seen(info) {
    const token = normToken(info && info.token);
    if (!token) return json({ ok: false, error: 'token 不合法' }, 400);

    let p = this.db.players[token];
    if (!p) {
      p = this.db.players[token] = {
        name: nameOf(info.name),
        avatar: info.avatar ? String(info.avatar).slice(0, 24) : null,
        first: Date.now(),
        rate: { r: START_RATING, w: 0, l: 0, games: 0, best: START_RATING }
      };
    }
    if (info.name) p.name = nameOf(info.name);
    if (info.avatar) p.avatar = String(info.avatar).slice(0, 24);
    if (info.room !== undefined) p.room = info.room ? String(info.room).slice(0, 8) : null;

    p.last = Date.now();
    this.db.onlineAt[token] = Date.now();
    await this.save();
    return json({ ok: true, profile: this.publicProfile(token) });
  }

  /* ------------------------------------------------------------ 好友 */

  async addPair(a, b) {
    if (!this.db.friends[a]) this.db.friends[a] = [];
    if (!this.db.friends[b]) this.db.friends[b] = [];
    if (!this.db.friends[a].includes(b)) this.db.friends[a].push(b);
    if (!this.db.friends[b].includes(a)) this.db.friends[b].push(a);
  }

  async dropRequest(owner, from) {
    const q = this.db.requests[owner];
    if (!q) return;
    this.db.requests[owner] = q.filter((r) => r.from !== from);
  }

  async friendRequest(body) {
    const me = normToken(body && body.token);
    if (!me) return json({ ok: false, error: 'token 不合法' }, 400);
    if (!this.db.players[me]) return json({ ok: false, error: '先报到（/seen）再加好友' }, 400);

    const target = this.resolve(body.to);
    if (!target) return json({ ok: false, error: '找不到这个人（短号可能不唯一）' }, 404);
    if (target === me) return json({ ok: false, error: '不能加自己' }, 400);

    const mine = this.db.friends[me] || [];
    if (mine.includes(target)) return json({ ok: true, already: true });

    /* ★ 对方已经请求过我 → 直接互相加，不要再造一条反向请求卡住 */
    const inbound = this.db.requests[me] || [];
    if (inbound.some((r) => r.from === target)) {
      await this.addPair(me, target);
      await this.dropRequest(me, target);
      await this.save();
      return json({ ok: true, mutual: true });
    }

    if (!this.db.requests[target]) this.db.requests[target] = [];
    const q = this.db.requests[target];
    if (q.length >= MAX_REQUESTS) return json({ ok: false, error: '对方的请求太多了' }, 429);
    /* 幂等：连点五次只留一条 */
    if (!q.some((r) => r.from === me)) {
      const p = this.db.players[me];
      q.push({ from: me, name: p.name, avatar: p.avatar || null, at: Date.now() });
    }
    await this.save();
    return json({ ok: true });
  }

  async friendAccept(body) {
    const me = normToken(body && body.token);
    if (!me) return json({ ok: false, error: 'token 不合法' }, 400);
    const from = this.resolve(body.from);
    if (!from) return json({ ok: false, error: '找不到请求方' }, 404);

    const inbound = this.db.requests[me] || [];
    if (!inbound.some((r) => r.from === from)) {
      return json({ ok: false, error: '没有这条请求（可能已经处理过）' }, 404);
    }
    if ((this.db.friends[me] || []).length >= MAX_FRIENDS) {
      return json({ ok: false, error: '好友已达上限' }, 400);
    }

    await this.addPair(me, from);
    await this.dropRequest(me, from);
    await this.save();
    return json({ ok: true });
  }

  async friendReject(body) {
    const me = normToken(body && body.token);
    const from = this.resolve(body && body.from);
    if (!me || !from) return json({ ok: false, error: '参数不合法' }, 400);
    await this.dropRequest(me, from);
    await this.save();
    return json({ ok: true });
  }

  async friendRemove(body) {
    const me = normToken(body && body.token);
    const other = this.resolve(body && body.friend);
    if (!me || !other) return json({ ok: false, error: '参数不合法' }, 400);

    /* 双向删：只删一边会出现"A 的列表里还有 B" */
    this.db.friends[me] = (this.db.friends[me] || []).filter((t) => t !== other);
    this.db.friends[other] = (this.db.friends[other] || []).filter((t) => t !== me);
    await this.save();
    return json({ ok: true });
  }

  friendList(token) {
    const me = normToken(token);
    if (!me) return json({ ok: false, error: 'token 不合法' }, 400);

    const friends = (this.db.friends[me] || []).map((t) => {
      const p = this.db.players[t];
      const online = this.isOnline(t);
      return {
        id: this.short(t),                 // ★ 只给短号，永远不返回对方的完整 token
        name: (p && p.name) || '玩家',
        avatar: (p && p.avatar) || null,
        online,
        room: online ? (p && p.room) || null : null
      };
    }).sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));

    const incoming = (this.db.requests[me] || []).map((r) => ({
      id: this.short(r.from),
      name: r.name || '玩家',
      avatar: r.avatar || null,
      at: r.at
    }));

    return json({ ok: true, friends, incoming });
  }

  /* ------------------------------------------------------- 分数与排行 */

  async applyResult(body) {
    const token = normToken(body && body.token);
    if (!token) return json({ ok: false, error: 'token 不合法' }, 400);

    const p = this.db.players[token];
    /* ★ 不凭空建档。没有资料说明这个身份没报到过，可能是伪造的 token，
       也可能是座位令牌被误当成了账号令牌（那会造出一堆幽灵号）。 */
    if (!p) return json({ ok: false, error: '身份不存在，先报到' }, 404);

    const won = !!body.won;
    const r = p.rate || (p.rate = { r: START_RATING, w: 0, l: 0, games: 0, best: START_RATING });

    r.r = Math.max(0, r.r + (won ? WIN_DELTA : -WIN_DELTA));
    r.games += 1;
    if (won) r.w += 1; else r.l += 1;
    if (r.r > r.best) r.best = r.r;
    p.last = Date.now();

    await this.save();
    return json({
      ok: true,
      rate: { r: r.r, w: r.w, l: r.l, games: r.games, best: r.best },
      delta: won ? WIN_DELTA : -WIN_DELTA
    });
  }

  ladder(top = 50) {
    const rows = Object.keys(this.db.players)
      .map((t) => ({ t, p: this.db.players[t] }))
      .filter(({ p }) => p.rate && p.rate.games >= MIN_GAMES_FOR_BOARD && p.name)
      .sort((a, b) => (b.p.rate.r - a.p.rate.r) || (b.p.rate.games - a.p.rate.games))
      .slice(0, Math.max(1, Math.min(200, Number(top) || 50)))
      .map(({ t, p }) => ({
        id: this.short(t),            // ★ 脱敏
        name: p.name,
        avatar: p.avatar || null,
        r: p.rate.r,
        w: p.rate.w,
        l: p.rate.l,
        games: p.rate.games
      }));
    return json({ ok: true, rows, minGames: MIN_GAMES_FOR_BOARD });
  }

  /* ------------------------------------------------------------ 路由 */

  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    const body = async () => {
      try { return await request.json(); } catch { return {}; }
    };

    if (p.endsWith('/seen') && request.method === 'POST') return this.seen(await body());
    if (p.endsWith('/profile')) return json({ ok: true, profile: this.publicProfile(normToken(url.searchParams.get('token'))) });
    if (p.endsWith('/friend/list')) return this.friendList(url.searchParams.get('token'));
    if (p.endsWith('/friend/request') && request.method === 'POST') return this.friendRequest(await body());
    if (p.endsWith('/friend/accept') && request.method === 'POST') return this.friendAccept(await body());
    if (p.endsWith('/friend/reject') && request.method === 'POST') return this.friendReject(await body());
    if (p.endsWith('/friend/remove') && request.method === 'POST') return this.friendRemove(await body());
    if (p.endsWith('/result') && request.method === 'POST') return this.applyResult(await body());
    if (p.endsWith('/ladder')) return this.ladder(url.searchParams.get('top'));

    return json({ ok: false, error: '未知接口' }, 404);
  }
}
