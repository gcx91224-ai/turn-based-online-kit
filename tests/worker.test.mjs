/* =============================================================================
 * Worker 路由测试
 *
 * 这里不启动 Cloudflare，只验证「请求该被送到哪」：
 *   - 建房返回合法房间码
 *   - 邀请链接内部请求的是 '/'，不是 '/index.html'（否则会 307 丢掉房间码）
 *   - /ws 必须带升级头
 * ========================================================================== */

import test from 'node:test';
import assert from 'node:assert/strict';
import { installGlobals } from './helpers.mjs';
import { isValidCode } from '../worker/protocol.js';

installGlobals();
const worker = (await import('../worker/index.js')).default;

function makeEnv() {
  const assetPaths = [];
  const roomHits = [];

  const env = {
    ASSETS: {
      async fetch(req) {
        const path = new URL(req.url).pathname;
        assetPaths.push(path);
        return { status: 200, body: 'asset:' + path, async json() { return { path }; } };
      }
    },
    ROOMS: {
      idFromName(name) { return name; },
      get(id) {
        return {
          async fetch(req) {
            roomHits.push({ id, url: req.url });
            /* 建房查重会问 /status：这里假装房间是空的 */
            if (String(req.url).includes('/status')) {
              return {
                status: 200,
                body: JSON.stringify({ ok: true, room: { occupied: false } }),
                async json() { return { ok: true, room: { occupied: false } }; }
              };
            }
            return { status: 101, body: null };
          }
        };
      }
    }
  };
  return { env, assetPaths, roomHits };
}

function wsReq(path) {
  return {
    url: 'https://game.example.com' + path,
    method: 'GET',
    headers: { get: (k) => String(k).toLowerCase() === 'upgrade' ? 'websocket' : null }
  };
}

test('POST /api/room 返回合法房间码', async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(new Request('https://game.example.com/api/room', { method: 'POST' }), env);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.ok(isValidCode(body.code), '房间码不合法: ' + body.code);
});

test('GET /api/room 拒绝非法房间码', async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(new Request('https://game.example.com/api/room?room=ABC'), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).ok, false);
});

test('★ 邀请链接内部请求的是 "/"，不是 "/index.html"', async () => {
  const { env, assetPaths } = makeEnv();
  const res = await worker.fetch(new Request('https://game.example.com/r/AB3CD'), env);

  assert.equal(res.status, 200);
  assert.deepEqual(assetPaths, ['/'], '请求 /index.html 会被 307 跳回 /，房间码就丢了');
});

test('邀请链接里的房间码必须合法', async () => {
  const { env, assetPaths } = makeEnv();
  const res = await worker.fetch(new Request('https://game.example.com/r/ABC'), env);
  assert.equal(res.status, 400);
  assert.equal(assetPaths.length, 0);
});

test('/ws 不带升级头 → 426', async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(new Request('https://game.example.com/ws?room=AB3CD'), env);
  assert.equal(res.status, 426);
});

test('/ws 带升级头 → 转发到对应房间的 DO', async () => {
  const { env, roomHits } = makeEnv();
  const res = await worker.fetch(wsReq('/ws?room=ab3cd&token=token-aaaa-1111&name=A'), env);

  assert.equal(res.status, 101);
  assert.equal(roomHits.length, 1);
  assert.equal(roomHits[0].id, 'AB3CD', '房间码要先归一化成大写再寻址');
});

test('/ws 房间码不合法 → 400，不会调到 DO', async () => {
  const { env, roomHits } = makeEnv();
  const res = await worker.fetch(wsReq('/ws?room=AB1CD'), env);   // 1 不在字母表里
  assert.equal(res.status, 400);
  assert.equal(roomHits.length, 0);
});

test('其余路径原样交给静态资源', async () => {
  const { env, assetPaths } = makeEnv();
  await worker.fetch(new Request('https://game.example.com/style.css'), env);
  assert.deepEqual(assetPaths, ['/style.css']);
});
