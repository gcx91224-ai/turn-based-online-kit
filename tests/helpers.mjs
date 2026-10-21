/* =============================================================================
 * 测试用的假环境
 *
 * 目的：不启动 workerd、不连网络，就能把 Durable Object 的消息处理器跑起来。
 * 真实 DO 给的东西这里都有最小实现：
 *   ctx.storage.get/put/delete/setAlarm/deleteAlarm
 *   ctx.acceptWebSocket / getWebSockets / blockConcurrencyWhile
 *   WebSocketPair（两个假 socket）
 *   Response（原生 Response 不接受 101，WebSocket 升级要用）
 * ========================================================================== */

export class FakeSocket {
  constructor() {
    this.attachment = null;
    this.messages = [];
    this.readyState = 1;
  }
  serializeAttachment(a) { this.attachment = a; }
  deserializeAttachment() { return this.attachment; }
  send(data) { this.messages.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  last() { return this.messages[this.messages.length - 1]; }
  clear() { this.messages = []; }
}

class FakeResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status || 200;
    this.headers = init.headers || {};
    this.webSocket = init.webSocket || null;
  }
  async json() { return JSON.parse(this.body); }
}

export function installGlobals() {
  globalThis.WebSocketPair = class {
    constructor() {
      this[0] = new FakeSocket();
      this[1] = new FakeSocket();
    }
  };
  globalThis.Response = FakeResponse;
}

export function makeCtx() {
  const store = new Map();
  const sockets = [];
  const ctx = {
    alarmAt: null,
    ready: null,
    storage: {
      async get(key) {
        return store.has(key) ? structuredClone(store.get(key)) : undefined;
      },
      async put(key, value) {
        store.set(key, structuredClone(value));
      },
      async delete(key) {
        store.delete(key);
      },
      async setAlarm(ts) {
        ctx.alarmAt = ts;
      },
      async deleteAlarm() {
        ctx.alarmAt = null;
      }
    },
    getWebSockets() {
      return sockets;
    },
    acceptWebSocket(ws) {
      sockets.push(ws);
    },
    blockConcurrencyWhile(fn) {
      ctx.ready = fn();
    },
    /* 测试专用：读落盘的那份，确认状态真的持久化了 */
    async peek() {
      return store.has('room') ? structuredClone(store.get('room')) : undefined;
    }
  };
  return ctx;
}

/* room.js 只用到 request.url 和 headers.get('Upgrade')，
   这里给一个最小对象即可 —— 原生 Request 会把 Upgrade 当 forbidden header 丢掉。 */
export function wsRequest(code, token, name) {
  const url = 'https://room/ws?room=' + code +
    '&token=' + encodeURIComponent(token) +
    '&name=' + encodeURIComponent(name);
  return {
    url,
    method: 'GET',
    headers: {
      get(k) {
        return String(k).toLowerCase() === 'upgrade' ? 'websocket' : null;
      }
    }
  };
}

export function statusRequest(code) {
  return {
    url: 'https://room/status?room=' + code,
    method: 'GET',
    headers: { get: () => null }
  };
}

/* 模拟一个客户端断开：真实 DO 会把它从 getWebSockets 里移除 */
export function drop(ctx, ws) {
  const arr = ctx.getWebSockets();
  const i = arr.indexOf(ws);
  if (i >= 0) arr.splice(i, 1);
  ws.close();
}
