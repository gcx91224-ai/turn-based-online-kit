# 02 · 房间与身份

## 房间码怎么设计

```
AB3CD      ← 5 位，32 个字符里选，去掉了 0/O/1/I/L
```

**字符集**：`23456789ABCDEFGHJKMNPQRSTUVWXYZ`

去掉 `0 O 1 I L` 不是洁癖：这几个字符在手写、截图、语音念出来时都会混淆。
"是零还是欧"这种问题，在真实用户身上一天能出现好几次。

**长度**：5 位 = 32⁵ ≈ **3355 万**种。朋友局并发房间数是个位到几十，撞码概率可以忽略；
但仍然要**真查一次**，见下面。

**为什么不用自增 id / 房间列表**：

- 自增 id 会泄露"你的站有多少房间"，也容易被扫
- 房间列表适合"陌生人匹配"，朋友局的核心诉求是**发个链接就能进**
- 房间码可以口头念、可以写进群聊，这是最低摩擦的邀请方式

> 如果以后要做"公开房间列表"，再加一个全局索引 DO 就行，房间码不用改。
> 见 [09-limits](09-limits.md#想做公开房间列表)。

---

## 建房：生成 + 查重

```js
// worker/index.js
for (let attempt = 0; attempt < 6; attempt++) {
  const code = newRoomCode();
  const res = await roomStub(env, code).fetch(new Request('https://room/status'));
  const info = await res.json();
  if (info.room && !info.room.occupied) return json({ ok: true, code });
}
return json({ ok: false, error: '房间码生成失败，请重试' }, 503);
```

两个细节：

1. **查的是"有没有人坐"，不是"DO 存不存在"**。Durable Object 是懒创建的：
   你 fetch 一个从没被用过的名字，它也会建一个空实例。所以判据只能是 `occupied`。
2. **重试上限**。撞码概率再低也不能写 `while(true)` —— 万一你的随机源坏了，会变成死循环。

### DO 的 id 是单向的

```js
env.ROOMS.idFromName('AB3CD')   // 名字 → id，可以
// 反过来：id → 名字，拿不到
```

所以任何需要"房间码"的服务端逻辑，**要么把码存进房间状态里，要么从请求 URL 里带进来**。
本套件把码存在 `state.code`，同时 Worker 转发请求时 URL 里的 `?room=` 也还在。

---

## 身份：设备 token

```js
// 客户端生成，存 localStorage
crypto.randomUUID()   // 例如 550e8400-e29b-41d4-a716-446655440000
```

它回答的问题只有一个：**"这台设备是不是刚才那个座位的人"**。

| 能防 | 不能防 |
|---|---|
| 刷新页面后坐回原位 | 换设备/清缓存后找回身份 |
| 断线重连恢复对局 | 有人手动复制 token 冒充（没有密码） |
| 两个标签页抢座位 | 恶意用户批量建房 |
| 别人猜房间码进来（还得有空位） | 任何需要"证明你是你"的场景 |

**这不是登录系统，别当登录系统用。** 如果你要存档、排行榜、跨设备，必须加真正的账号
（邮箱/第三方登录），token 只作为"游客身份"。

### 为什么 token 不能给对手看

它等价于"这个座位的钥匙"。房间里只显示昵称和座位，**永远不要把对方的 token 发给客户端**。
本套件的广播里只有 `{name, online, you}`，token 始终留在服务器。

---

## 座位分配

```js
let seat = seatOfToken(st, token);      // 老玩家：找回原座位
if (!seat) {
  seat = freeSeat(st);                  // 新玩家：坐空位
  if (!seat) return json({ error: '房间已满', code: 'ROOM_FULL' }, 409);
  st.seats[seat] = { token, name };
}
```

顺序很重要：

1. **先按 token 找座位**，再找空位。反过来的话，刷新页面会被当成新人，坐到一个新座位上，
   房间里出现"幽灵玩家"。
2. **座位不随连接释放**。关掉页面时座位保留，token 还在，回来还能坐。
   否则"刷新一下对手就没了"。
3. 真要"离席"，自己加一个显式消息（`{type:'leave'}`），不要用断开连接当离席信号 ——
   网络抖动太常见了。

### 昵称可以改，座位不能

```js
} else if (st.seats[seat].name !== name) {
  st.seats[seat].name = name;   // 只更新显示名
}
```

用户改了昵称又回来，应该还是那个座位。**别把昵称当身份。**

---

## 满员怎么办

```js
return json({ ok: false, error: '房间已满', code: 'ROOM_FULL' }, 409);
```

浏览器拿不到 409 的 body（WebSocket 握手失败只会触发 `onclose`），所以前端只能显示
"进不去，可能满员了"。如果要做观战，就不该拒绝连接，而是分配一个 `spectator` 角色：

```js
// 扩展思路
seat = freeSeat(st) || null;
if (!seat) role = 'spectator';
```

观战者收到的是**裁剪得更狠**的视图（比如只能看已结算的结果，不能看当前回合的 pick）。

---

## 邀请链接：两个必踩的坑

### 坑一：`/index.html` 会 307 跳走

Cloudflare 静态资源默认 `html_handling: auto-trailing-slash`：

```
GET /            → 200 index.html
GET /index.html  → 307 Location: /
```

于是 `GET /r/AB3CD` 如果内部去取 `/index.html`，浏览器会被弹到 `/`，
**URL 里的房间码没了**，前端读不到，邀请链接整个失效。

正确做法是内部请求 `/`：

```js
if (/^\/r\/[^/?#]+/.test(path)) {
  return serveAsset(env, request, '/');   // ★ 不是 '/index.html'
}
```

### 坑二：相对路径会被解析到 `/r/` 下

HTML 挂在 `/r/AB3CD` 这个地址上，那么页面里的 `style.css`、`app.js`
会被浏览器解析成 `/r/style.css`、`/r/app.js` —— 而 `/r/*` 在 Worker 里是房间码路由，直接 400。

结果：**页面白板，没样式没脚本**。

```html
<!-- 必须是内联同步脚本，<base> 要在后面的标签被解析前生效 -->
<script>
  if (location.protocol !== 'file:') document.write('<base href="/">');
</script>
```

为什么加 `file:` 判断：本地双击 `index.html` 时没有"站点根"，写死 `href="/"` 会去读磁盘根目录，
把单机预览也弄坏。

---

## 房间的生命周期

- 房间在**第一个人连上时**才真正创建（DO 懒创建）
- 没人连了，DO 会休眠，但 `storage` 里的数据**还在**
- 没有"硬删除"接口。要清理只能：
  - 在房间状态里存 `createdAt`，下次唤醒时判断过期就重置
  - 或者接受它一直躺着（一个房间几十 KB，免费额度 5GB）
- **不要在房间里存敏感信息**。任何知道房间码的人都能进（如果还有空位），
  而房间码是可以被猜的（3355 万种，但并非不可能）

下一步：[03 · 回合、结算与公平性](03-turns-and-fair-play.md)
