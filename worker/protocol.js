/* =============================================================================
 * 协议工具：房间码、名字/身份校验
 *
 * 这里只有纯函数，不碰网络、不碰存储 —— 所以可以直接在 Node 里跑测试。
 * ========================================================================== */

/* 32 个字符，去掉了 0/O/1/I/L 这些「看一眼分不清」的。
   5 位 = 32^5 ≈ 3355 万种，小游戏完全够用。 */
export const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LEN = 5;
const CODE_RE = new RegExp('^[' + ALPHABET + ']{' + CODE_LEN + '}$');

export function normalizeCode(input) {
  if (typeof input !== 'string') return '';
  return input.trim().toUpperCase();
}

export function isValidCode(input) {
  return CODE_RE.test(normalizeCode(input));
}

/* 生成房间码。
   拒绝采样：256 不是 32 的整数倍时直接取模会有偏置（现在 256/32 正好整除，
   但这个写法能防止以后改字母表时悄悄引入偏差）。 */
export function newRoomCode() {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let out = '';
  while (out.length < CODE_LEN) {
    const bytes = new Uint8Array(CODE_LEN * 2);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length && out.length < CODE_LEN; i++) {
      if (bytes[i] >= limit) continue;
      out += ALPHABET[bytes[i] % ALPHABET.length];
    }
  }
  return out;
}

/* 昵称：去空白、限长，空的话给个默认值。
   不校验内容 —— 前端一律用 textContent 渲染，不做 innerHTML 拼接。 */
export function sanitizeName(input) {
  const s = (typeof input === 'string' ? input : '').trim().slice(0, 16);
  return s || '玩家';
}

/* 身份 token：客户端生成（UUID 即可），存 localStorage。
   它只是「这台设备是谁」，不是密码 —— 文档里会讲清楚它能防什么、不能防什么。 */
export function isValidToken(input) {
  return typeof input === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(input);
}
