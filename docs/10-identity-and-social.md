# 10 · 身份、好友与权限

前面几篇只解决"两个人怎么打一局"。这一篇解决"打完还想再找他"。

这是从玩具变成有人愿意反复玩的游戏之间，最长的一段路。

---

## 三层身份，别混用

联机项目里最常见的架构 bug，是把这三种身份当成一个东西：

| 层 | 谁生成 | 活多久 | 用来干什么 |
|---|---|---|---|
| **座位令牌** | 服务器，进房时 | 一局 / 一个房间 | 标记"这个 WebSocket 坐哪个位子" |
| **设备 token** | 客户端，localStorage | 直到清缓存 | 认人：重连、分数、好友 |
| **账号** | 登录系统 | 长期 | 跨设备、找回、封禁 |

### 血泪教训：拿座位令牌去写分

```
玩家打完一局 → 服务器用「座位令牌」给他加分
             → 下一局又生成一个新的座位令牌
             → 每打一局，排行榜上就多一个"新玩家"
```

表现是：榜单上一堆同名幽灵号，每个人的分数都只有一两局。

**规则：座位令牌只用于房间内的路由，任何持久化的东西（分数、好友、成就）必须用设备 token。**

### 设备 token 不是账号

它回答"这台设备是谁"，仅此而已：

- 清缓存 → 换人
- 换设备 → 换人
- 复制给别人 → 冒充（没有密码）

如果你的游戏只是"和朋友玩几把"，这够了。要做真排行榜/跨设备存档，必须加登录
（邮箱验证码最省事），设备 token 降级成"游客 id"。

---

## 短号：给用户看的 id

设备 token 是 32-64 位，**不能给对手看**（等于座位钥匙），也没法口头念。

```js
shortCode(token) { return token.slice(0, 8); }   // 550e8400
```

用途：

- 好友列表里区分同名的人
- 排行榜展示（不暴露 token）
- 线下加好友："我短号是 550e8400"

**短号不是凭据。** 它只是一个展示用 id，不能拿来登录。服务端可以支持"按短号加好友"，
但那是"发一个请求给别人"，不是"证明我是他"。

### 短号会撞

8 位十六进制 ≈ 43 亿，用户量小不会撞。但如果你要更稳：

- 用更大的空间（12 位）
- 或者加校验位，撞了让用户换

对朋友局，8 位够了。**别为不存在的问题加复杂度。**

---

## 好友：数据模型

不要用"单链表"（`A.friends = [B]`），因为：

- 关系是双向的，单边写会不一致
- 请求是有方向的，必须区分"我发出去的"和"别人发我的"

三张表：

```js
{
  friends:  { [meToken]: [friendToken, ...] },          // 双向都写
  requests: { [toToken]: [{ from, name, avatar, at }] }, // 入站请求
  onlineAt: { [token]: timestamp }                       // 最近心跳
}
```

### 请求 → 接受

```js
async friendRequest(from, to) {
  if (from === to) return { ok: false, error: '不能加自己' };
  if (isFriend(from, to)) return { ok: false, error: '已经是好友' };

  // ★ 对方已经请求过我 → 直接互相加，不要再造一条请求
  if (requests[from]?.some(r => r.from === to)) {
    await addPair(from, to);
    removeRequest(from, to);
    return { ok: true, mutual: true };
  }

  // 去重：我连着点五次，只留一条
  const q = requests[to] || (requests[to] = []);
  if (!q.some(r => r.from === from)) {
    q.push({ from, name, avatar, at: Date.now() });
  }
  return { ok: true };
}
```

**`addPair` 必须双向写**，并且要幂等：

```js
async function addPair(a, b) {
  if (!friends[a]?.includes(b)) (friends[a] ||= []).push(b);
  if (!friends[b]?.includes(a)) (friends[b] ||= []).push(a);
}
```

否则会出现"A 的列表里有 B，B 的列表里没有 A"——用户会以为功能坏了。

### 在线判定：心跳，不是连接

```js
const FRIEND_TTL = 45_000;   // 心跳 20 秒，留一次丢失的余量
const online = (onlineAt[token] || 0) > Date.now() - FRIEND_TTL;
```

为什么不用"他有没有 WebSocket 连着"：好友可能在**别的房间**、在大厅、在主页。
连接是房间维度的，在线是全站维度的。

心跳由客户端定时打（20 秒一次），顺手带上"我在哪个房间"，好友列表就能显示"加入他的房间"。

### 房间内加好友：走 WebSocket 中转

为什么不直接让 A 调 `POST /api/friend/request { from: A_token, to: B_token }`？

因为**A 根本不知道 B 的 token**。token 是隐私，房间里只传座位号。

正确流程：

```
A 点 B 的头像 → 发 {type:'friendReq', to:'B'}（房间内 WS）
  → 服务器从座位 B 的 attachment 里查出 B 的 token
  → 存请求 + 推给 B 的 WS
  → B 点同意 → {type:'friendAccept', from:'A'}
```

好处：

- token 全程不出服务器
- 陌生人无法离线骚扰（必须先同房）
- 天然点对点，不需要搜索用户

**不要为了省事在客户端之间传 token。** 一旦传了，就等于把座位钥匙发出去了。

---

## 权限：界面禁用不是权限

房主能改玩法、能踢人、能开局。这些规则必须**服务端校验**：

```js
case 'config': {
  if (await this.hostSeat() !== at.seat) return;   // ★ 不是房主，直接忽略
  ...
}
```

前端把按钮灰掉只是体验。用户打开 DevTools 能发任意消息。

### 房主是谁

```js
async hostSeat() {
  // 最小座位号 = 房主。唯一规则，前后端必须一致。
  const seats = await this.seatMap();
  return Object.keys(seats).filter(s => seats[s]).sort()[0] || null;
}
```

用"最小座位"而不是"第一个进来的人"，是因为第一个进来的人可能走了。
座位号是稳定的，重算不会变。

### 房主掉线怎么办

如果不处理，房主一走，房间就永远改不了配置、开不了下一局。

```js
async webSocketClose(ws) {
  const at = ws.deserializeAttachment();
  if (at.seat === await this.hostSeat() && !this.hasLiveConnection(at.seat)) {
    // 房主离线 → 自动移交给下一个在线的人
    await this.broadcast({ type: 'hostChanged', seat: nextOnlineSeat });
  }
}
```

"在线"用 `getWebSockets()` 实时判断，不要存字段（刷新会闪）。

---

## 这一层的验收清单

- [ ] 刷新页面，好友列表里的"在线"不会闪成离线
- [ ] 连续点五次"加好友"，对方只收到一条请求
- [ ] A 加 B、B 同时加 A → 直接成为好友，不会出现两条互等的请求
- [ ] 删除好友后，双方列表都没了
- [ ] 好友在别的房间，列表里能看到"加入"
- [ ] 普通玩家改配置，服务端不认（用 DevTools 发消息验证）
- [ ] 房主退出后，另一个人能改配置
- [ ] 排行榜上不出现任何完整 token

下一步：[11 · 排位与匹配](11-rank-and-match.md)
