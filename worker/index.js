/* =============================================================================
 * Worker 入口
 *
 * 一个 Worker 装下全部，静态文件和 WebSocket 同一个源 —— 没有 CORS，没有跨域 Cookie 问题。
 *
 *   /                静态文件（public/ 由 Cloudflare 直接发）
 *   /r/<房间码>       邀请链接：也发 index.html，前端自己从 URL 里读房间码
 *   POST /api/room   生成一个没被占用的房间码
 *   GET  /api/room   查房间状态（人数、阶段）
 *   /ws?room=XX      升级成 WebSocket，转发给这个房间的 Durable Object
 * ========================================================================== */

import { Room } from './room.js';
import { newRoomCode, normalizeCode, isValidCode } from './protocol.js';

export { Room };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

/* 房间码 → DO 实例。同一个码永远落到同一个实例。 */
function roomStub(env, code) {
  return env.ROOMS.get(env.ROOMS.idFromName(code));
}

async function serveAsset(env, request, path) {
  const url = new URL(request.url);
  url.pathname = path;
  return env.ASSETS.fetch(new Request(url.toString(), request));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    /* ------------------------------------------------------ 建房 / 查房 */
    if (path === '/api/room') {
      if (request.method === 'POST') {
        /* 撞码概率极低（32^5），但仍然真查一下 —— 万一撞了，
           会把别人的房间覆盖掉，那种 bug 极难排查。 */
        for (let attempt = 0; attempt < 6; attempt++) {
          const code = newRoomCode();
          const res = await roomStub(env, code).fetch(new Request('https://room/status'));
          let info = null;
          try {
            info = await res.json();
          } catch {
            /* 当作不可用，换一个码重试 */
          }
          if (info && info.room && !info.room.occupied) {
            return json({ ok: true, code });
          }
        }
        return json({ ok: false, error: '房间码生成失败，请重试' }, 503);
      }

      const code = normalizeCode(url.searchParams.get('room'));
      if (!isValidCode(code)) return json({ ok: false, error: '房间码不合法' }, 400);

      const res = await roomStub(env, code).fetch(new Request('https://room/status'));
      return new Response(res.body, {
        status: res.status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
      });
    }

    /* --------------------------------------------------------- WebSocket */
    if (path === '/ws') {
      const code = normalizeCode(url.searchParams.get('room'));
      if (!isValidCode(code)) return json({ ok: false, error: '房间码不合法' }, 400);
      if (request.headers.get('Upgrade') !== 'websocket') {
        return json({ ok: false, error: '这个端点需要 WebSocket 升级' }, 426);
      }
      return roomStub(env, code).fetch(request);
    }

    /* ------------------------------------------------------ 邀请链接 */
    if (/^\/r\/[^/?#]+/.test(path)) {
      const code = normalizeCode(decodeURIComponent(path.slice(3)));
      if (!isValidCode(code)) return json({ ok: false, error: '房间码不合法' }, 400);

      /* ★ 必须请求 '/'，不能请求 '/index.html'。
         Cloudflare 静态资源的 html_handling 默认是 auto-trailing-slash：
         请求 /index.html 会被 307 跳回 /，于是邀请链接一打开就被弹走、
         URL 里的房间码没了，前端就读不到房间。
         请求 '/' 不会跳转，返回的 HTML 由浏览器挂在 /r/<码> 这个地址上。 */
      return serveAsset(env, request, '/');
    }

    /* ------------------------------------------------------ 其余静态文件 */
    return serveAsset(env, request, path);
  }
};
