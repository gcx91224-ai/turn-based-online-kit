/* =============================================================================
 * 前端：一个文件，无框架、无构建
 *
 * 它只做三件事：
 *   1. 维护连接（连上、断了退避重连、20 秒心跳）
 *   2. 把服务器发来的 state 画出来（服务器是权威，前端不做任何判定）
 *   3. 把点击变成 {type:'pick'} / {type:'again'}
 *
 * ★ 所有用户输入（昵称）渲染前都过 esc() —— 不要用 innerHTML 直接拼原始字符串。
 * ========================================================================== */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var LS_TOKEN = 'kit_token';
  var LS_NAME = 'kit_name';
  var MAX_TRIES = 5;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function makeToken() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var a = new Uint8Array(16);
    crypto.getRandomValues(a);
    var out = '';
    for (var i = 0; i < a.length; i++) out += a[i].toString(16).padStart(2, '0');
    return out;
  }

  function readCode() {
    var m = /^\/r\/([^/?#]+)/.exec(location.pathname);
    if (m) return decodeURIComponent(m[1]).toUpperCase();
    var q = new URLSearchParams(location.search).get('room');
    return q ? q.trim().toUpperCase() : '';
  }

  var S = {
    token: '',
    name: '',
    code: '',
    ws: null,
    state: null,
    conn: 'idle',        // idle | connecting | open | closed | failed
    tries: 0,
    ping: null,
    picked: null,
    toastTimer: null
  };

  try {
    S.token = localStorage.getItem(LS_TOKEN) || '';
    S.name = localStorage.getItem(LS_NAME) || '';
    if (!S.token) {
      S.token = makeToken();
      localStorage.setItem(LS_TOKEN, S.token);
    }
  } catch (e) {
    S.token = makeToken();
  }

  /* ------------------------------------------------------------- 提示条 */

  function toast(text, ms) {
    var el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(function () { el.hidden = true; }, ms || 2600);
  }

  /* --------------------------------------------------------------- 渲染 */

  function render() {
    var who = $('who');
    var tag = '';
    if (S.conn === 'connecting') tag = ' · 连接中';
    else if (S.conn === 'open') tag = ' · 已连接';
    else if (S.conn === 'closed') tag = ' · 重连中';
    else if (S.conn === 'failed') tag = ' · 连接失败';
    who.textContent = S.name ? S.name + tag : tag.replace(/^ · /, '');

    if (!S.name) return renderName();
    if (!S.code) return renderHome();

    var st = S.state;
    if (!st) return renderConnecting();

    if (st.phase === 'waiting') return renderWaiting(st);
    if (st.phase === 'playing') return renderPlaying(st);
    return renderOver(st);
  }

  function renderName() {
    $('screen').innerHTML =
      '<div class="card">' +
        '<h1>先起个名字</h1>' +
        '<p class="muted">只在这个房间里显示，存在你自己的浏览器里。</p>' +
        '<div class="field">' +
          '<input id="nameInput" maxlength="16" placeholder="比如：老王" autocomplete="nickname" />' +
          '<button class="primary" id="btnName">进入</button>' +
        '</div>' +
      '</div>';
    var input = $('nameInput');
    input.value = S.name;
    input.focus();
    input.onkeydown = function (e) { if (e.key === 'Enter') saveName(); };
    $('btnName').onclick = saveName;
  }

  function saveName() {
    var v = ($('nameInput').value || '').trim().slice(0, 16);
    if (!v) return toast('名字不能为空');
    S.name = v;
    try { localStorage.setItem(LS_NAME, v); } catch (e) {}
    if (S.code) connect();
    else render();
  }

  function renderHome() {
    $('screen').innerHTML =
      '<div class="card">' +
        '<h1>和朋友开一局</h1>' +
        '<p class="muted">一个人建房，把 5 位房间码或邀请链接发给朋友。两人到齐自动开始。</p>' +
        '<button class="primary wide" id="btnCreate" style="margin-top:14px">创建房间</button>' +
      '</div>' +
      '<div class="card">' +
        '<h2>加入房间</h2>' +
        '<div class="field">' +
          '<input id="joinInput" maxlength="5" placeholder="5 位房间码" autocapitalize="characters" autocomplete="off" />' +
          '<button id="btnJoin">加入</button>' +
        '</div>' +
        '<p class="muted" style="margin-top:12px">房间码只用大写字母和数字，去掉了 0/O/1/I 这类容易看错的字符。</p>' +
      '</div>';

    $('btnCreate').onclick = createRoom;
    var j = $('joinInput');
    j.onkeydown = function (e) { if (e.key === 'Enter') joinRoom(j.value); };
    $('btnJoin').onclick = function () { joinRoom(j.value); };
  }

  function renderConnecting() {
    var msg = S.conn === 'failed'
      ? '<p class="muted">连不上这个房间。可能已经满员（只支持两人），或者刚被关掉了。</p>' +
        '<button class="wide" id="btnBack" style="margin-top:14px">回首页</button>'
      : '<p class="muted"><span class="spinner"></span>正在进入房间…</p>';

    $('screen').innerHTML = '<div class="card">' + msg + '</div>';
    if (S.conn === 'failed') {
      $('btnBack').onclick = function () { location.href = '/'; };
    }
  }

  function renderWaiting(st) {
    var you = st.you;
    var opp = you === 'A' ? 'B' : 'A';
    var a = st.players[you];
    var b = st.players[opp];
    var link = location.origin + '/r/' + st.code;

    $('screen').innerHTML =
      '<div class="card">' +
        '<h2>房间已创建</h2>' +
        '<div class="code">' + esc(st.code) + '</div>' +
        '<div class="linkbox"><span>' + esc(link) + '</span><button id="btnCopy">复制</button></div>' +
        '<div class="seats">' +
          '<div class="seat you"><div class="name">' + esc(a.name || '你') + '</div><div class="tag">你 · 已就位</div></div>' +
          '<div class="seat"><div class="name">' + (b.joined ? esc(b.name) : '等待加入') + '</div>' +
            '<div class="tag">' + (b.joined ? (b.online ? '对手 · 在线' : '对手 · 掉线') : '把链接发给朋友') + '</div></div>' +
        '</div>' +
        '<p class="muted center" style="margin-top:16px">两人到齐自动开始。</p>' +
      '</div>';

    var btn = $('btnCopy');
    if (btn) {
      btn.onclick = function () {
        var done = function () { toast('链接已复制，发给朋友就行'); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(link).then(done, function () { toast(link, 6000); });
        } else {
          toast(link, 6000);
        }
      };
    }
  }

  function moveLabel(m) {
    return { rock: '石头', paper: '布', scissors: '剪刀' }[m] || m;
  }

  function renderPlaying(st) {
    var you = st.you;
    var opp = you === 'A' ? 'B' : 'A';
    var me = st.players[you];
    var them = st.players[opp];

    var status;
    if (!them.online) status = '对手掉线了，等他回来…';
    else if (st.myPick) status = '你出了「' + moveLabel(st.myPick) + '」，等对手…';
    else if (st.oppReady) status = '对手已经出招了';
    else status = '同时出招，谁也看不到谁的选择';

    var resultHTML = '';
    if (st.lastResult) {
      var lr = st.lastResult;
      var mine = lr.picks[you];
      var theirs = lr.picks[opp];
      var cls = lr.winner === 'draw' ? 'draw' : (lr.winner === you ? 'win' : 'lose');
      var word = lr.winner === 'draw' ? '平局' : (lr.winner === you ? '你赢了' : '你输了');
      resultHTML = '<div class="result">上一回合：' +
        '<span class="' + cls + '">' + word + '</span><br />' +
        esc(moveLabel(mine)) + ' 对 ' + esc(moveLabel(theirs)) +
        '</div>';
    }

    var moves = ['rock', 'paper', 'scissors'].map(function (m) {
      var chosen = st.myPick === m;
      return '<button class="move' + (chosen ? ' chosen' : '') + '" data-move="' + m + '"' +
        (st.myPick ? ' disabled' : '') + '>' + moveLabel(m) + '</button>';
    }).join('');

    $('screen').innerHTML =
      '<div class="card">' +
        '<div class="scoreboard">' +
          '<div class="center"><div class="num">' + st.score[you] + '</div><div class="muted">你</div></div>' +
          '<div class="vs">先到 ' + st.winScore + '</div>' +
          '<div class="center"><div class="num">' + st.score[opp] + '</div><div class="muted">' + esc(them.name || '对手') + '</div></div>' +
        '</div>' +
        '<div class="roundline">第 ' + st.round + ' 回合 · 30 秒内出招</div>' +
        '<div class="moves">' + moves + '</div>' +
        '<div class="status">' + status + '</div>' +
        resultHTML +
      '</div>';

    var btns = document.querySelectorAll('button[data-move]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].onclick = function () { pick(this.getAttribute('data-move')); };
    }
  }

  function renderOver(st) {
    var you = st.you;
    var opp = you === 'A' ? 'B' : 'A';
    var won = st.winner === you;

    var againText = st.again.you ? '已同意，等对手…' : '再来一局';

    $('screen').innerHTML =
      '<div class="card center">' +
        '<div class="big">' + (won ? '你赢了' : '你输了') + '</div>' +
        '<p class="muted">' + st.score[you] + ' : ' + st.score[opp] + '</p>' +
        '<button class="primary wide" id="btnAgain" style="margin-top:16px"' +
          (st.again.you ? ' disabled' : '') + '>' + againText + '</button>' +
        '<p class="muted" style="margin-top:12px">两人都点「再来一局」就重新开始。</p>' +
      '</div>';

    $('btnAgain').onclick = function () {
      if (!S.ws || S.ws.readyState !== 1) return toast('连接断了，正在重连');
      S.ws.send(JSON.stringify({ type: 'again' }));
    };
  }

  /* --------------------------------------------------------------- 动作 */

  function pick(move) {
    if (!S.ws || S.ws.readyState !== 1) return toast('连接断了，正在重连');
    if (!S.state || S.state.phase !== 'playing' || S.state.myPick) return;
    S.picked = move;
    S.ws.send(JSON.stringify({ type: 'pick', move: move }));
  }

  function createRoom() {
    if (location.protocol === 'file:') return toast('联机需要部署后访问，双击打开只能用来看界面');
    fetch('/api/room', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '建房失败');
        location.href = '/r/' + j.code;
      })
      .catch(function (e) { toast(e.message || '建房失败，看看网络'); });
  }

  function joinRoom(code) {
    var c = String(code || '').trim().toUpperCase();
    if (!/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/.test(c)) return toast('房间码是 5 位大写字母或数字');
    location.href = '/r/' + c;
  }

  /* --------------------------------------------------------------- 连接 */

  function connect() {
    if (!S.code || !S.name) return;
    if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) return;

    S.conn = 'connecting';
    render();

    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = proto + '//' + location.host + '/ws?room=' + encodeURIComponent(S.code) +
      '&token=' + encodeURIComponent(S.token) +
      '&name=' + encodeURIComponent(S.name);

    var ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      S.conn = 'failed';
      render();
      return;
    }
    S.ws = ws;

    ws.onopen = function () {
      S.conn = 'open';
      S.tries = 0;
      startPing();
      render();
    };

    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || m.type !== 'state') return;
      S.state = m;
      S.picked = m.myPick || null;
      render();
    };

    ws.onclose = function () {
      S.ws = null;
      stopPing();
      if (S.conn === 'failed') return;
      S.conn = 'closed';
      render();
      scheduleRetry();
    };

    ws.onerror = function () { /* onclose 一定会跟上来 */ };
  }

  function scheduleRetry() {
    if (!S.code || !S.name) return;
    if (S.tries >= MAX_TRIES) {
      S.conn = 'failed';
      render();
      return;
    }
    var wait = Math.min(8000, 800 * Math.pow(2, S.tries));
    S.tries += 1;
    setTimeout(function () { connect(); }, wait);
  }

  function startPing() {
    stopPing();
    S.ping = setInterval(function () {
      if (S.ws && S.ws.readyState === 1) {
        S.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 20000);
  }

  function stopPing() {
    if (S.ping) { clearInterval(S.ping); S.ping = null; }
  }

  /* --------------------------------------------------------------- 启动 */

  S.code = readCode();
  render();
  if (S.code && S.name) connect();

  window.addEventListener('pagehide', function () {
    stopPing();
    if (S.ws) S.ws.close();
  });
})();
