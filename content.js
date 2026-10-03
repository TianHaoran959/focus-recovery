/*
 * content.js —— 注入普通网页的 UI：右上角悬浮球 / 到点自检 / 走神回收 / 鼓励话术 / 娱乐提醒横幅
 * 全部 UI 放在 Shadow DOM 内，样式与宿主页完全隔离；本脚本不读取页面正文，只与后台消息通信。
 * 健壮性：挂载点被页面移除会自动重挂；每 15 秒向后台心跳重连；每秒做显示自愈，避免悬浮球“消失”。
 */
(function () {
  'use strict';
  if (window.__FR_INJECTED__) return;
  window.__FR_INJECTED__ = true;

  const DISTRACT_TAGS = ['看手机', '刷无关网页或视频', '发呆放空', '被他人打断', '想别的事', '处理杂事'];
  let session = null, mode = 'gentle', soundOn = false, uiPrefs = { ballPos: null, opacity: 0.95 };
  let selectedTag = null, dragMoved = false, dragStart = null, lastMenuState = null;

  function send(type, payload) {
    return new Promise(resolve => {
      let done = false;
      const fin = r => { if (!done) { done = true; resolve(r); } };
      const timer = setTimeout(() => fin(null), 1200); // 后台休眠/无响应时也不卡死 UI
      try {
        chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), r => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) { fin(null); return; } // v1.1.4: 处理lastError，避免Unchecked runtime.lastError导致扩展显示错误
          fin(r);
        });
      }
      catch (e) { clearTimeout(timer); fin(null); }
    });
  }

  // —— 挂载 Shadow 根 ——
  const host = document.createElement('div');
  host.id = 'fr-shadow-host';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;pointer-events:none';
  const rootEl = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  const STYLE = `
  :host, .fr-root, .fr-root * { box-sizing:border-box; font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; -webkit-font-smoothing:antialiased; }
  .fr-root { position:fixed; inset:0; pointer-events:none; color:#1f2937; }
  /* 悬浮球：沉浸自然风 毛玻璃胶囊 + 环形进度 */
  .fr-ball { position:absolute; top:24px; right:24px; display:flex; align-items:center; gap:9px; pointer-events:auto;
    background:linear-gradient(135deg,rgba(251,146,60,.95),rgba(249,115,22,.95)); color:#fff;
    border-radius:999px; padding:7px 14px 7px 7px; cursor:grab; user-select:none;
    box-shadow:0 8px 24px rgba(249,115,22,.35), inset 0 1px 0 rgba(255,255,255,.2);
    border:1px solid rgba(255,255,255,.25); backdrop-filter:blur(10px); transition:box-shadow .2s, transform .15s; }
  .fr-ball:hover { transform:translateY(-1px); box-shadow:0 10px 28px rgba(249,115,22,.45); }
  .fr-ball:active { cursor:grabbing; }
  .ring { width:38px; height:38px; position:relative; flex:0 0 38px; }
  .ring svg { width:38px; height:38px; transform:rotate(-90deg); }
  .ring .bg { fill:none; stroke:rgba(255,255,255,.25); stroke-width:4; }
  .ring .fg { fill:none; stroke:#fde047; stroke-width:4; stroke-linecap:round; transition:stroke-dashoffset .6s linear; filter:drop-shadow(0 0 3px rgba(253,224,71,.5)); }
  .meta { line-height:1.15; }
  .meta .t { font-size:17px; font-weight:700; font-variant-numeric:tabular-nums; letter-spacing:.3px; }
  .meta .s { font-size:10.5px; opacity:.92; margin-top:1px; }
  .fr-menu { display:none; position:absolute; top:calc(100% + 8px); right:0; width:132px; background:rgba(255,255,255,.95); backdrop-filter:blur(10px); color:#1f2937;
    border-radius:14px; padding:6px; box-shadow:0 12px 32px rgba(249,115,22,.2); border:1px solid rgba(255,255,255,.5); }
  .fr-ball.open .fr-menu { display:block; }
  .fr-menu button { pointer-events:auto; display:block; width:100%; margin:2px 0; padding:8px 10px; font-size:12.5px; text-align:left;
    color:#7c2d12; background:transparent; border:none; border-radius:9px; cursor:pointer; }
  .fr-menu button:hover { background:#ffedd5; }
  .fr-menu button.danger:hover { background:#fef2f2; color:#b91c1c; }
  .fr-root.is-fullscreen .fr-ball { padding:5px; border-radius:50%; gap:0; opacity:.6; }
  .fr-root.is-fullscreen .fr-ball:hover { opacity:1; }
  .fr-root.is-fullscreen .meta, .fr-root.is-fullscreen .fr-menu { display:none; }
  /* 遮罩 + 卡片（沉浸自然风 毛玻璃） */
  .fr-mask { pointer-events:auto; position:fixed; inset:0; background:rgba(31,41,55,.35); backdrop-filter:blur(4px);
    display:none; align-items:center; justify-content:center; }
  .fr-card { pointer-events:auto; width:380px; max-width:92vw; background:rgba(255,255,255,.92); backdrop-filter:blur(20px);
    border-radius:20px; padding:24px; box-shadow:0 24px 70px rgba(0,0,0,.25); animation:fr-pop .18s ease; overflow:hidden; position:relative;
    border:1px solid rgba(255,255,255,.6); }
  .fr-card::before { content:''; position:absolute; left:0; top:0; right:0; height:4px;
    background:linear-gradient(90deg,#fde047,#fb923c,#f97316); }
  @keyframes fr-pop { from { transform:scale(.95); opacity:.5; } to { transform:scale(1); opacity:1; } }
  .fr-card h3 { margin:2px 0 6px; font-size:18px; color:#7c2d12; }
  .fr-card .q { font-size:14px; color:#9a3412; margin-bottom:18px; line-height:1.55; }
  .fr-row { display:flex; gap:10px; }
  .fr-btn { flex:1; padding:12px 0; font-size:14px; border:none; border-radius:12px; cursor:pointer; font-weight:600; transition:filter .15s, transform .1s; }
  .fr-btn:active { transform:scale(.98); }
  .fr-btn.primary { background:linear-gradient(135deg,#fb923c,#f97316); color:#fff; box-shadow:0 4px 14px rgba(249,115,22,.35); }
  .fr-btn.primary:hover { filter:brightness(1.08); }
  .fr-btn.ghost { background:#ffedd5; color:#9a3412; } .fr-btn.ghost:hover { background:#fed7aa; }
  .fr-close { position:absolute; top:14px; right:16px; border:none; background:none; font-size:20px; line-height:1; color:#c2410c; cursor:pointer; opacity:.6; }
  .fr-close:hover { color:#7c2d12; opacity:1; }
  .fr-tags { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:14px; }
  .fr-tag { padding:7px 13px; font-size:13px; border-radius:999px; border:1px solid #fdba74; background:#fff7ed; color:#9a3412; cursor:pointer; transition:all .12s; }
  .fr-tag:hover { border-color:#f97316; }
  .fr-tag.on { background:linear-gradient(135deg,#fb923c,#f97316); color:#fff; border-color:#f97316; box-shadow:0 3px 10px rgba(249,115,22,.3); }
  .fr-input { width:100%; padding:11px 13px; font-size:13px; border:1px solid #fdba74; border-radius:11px; margin-bottom:14px; outline:none; background:#fff7ed; color:#1f2937; }
  .fr-input:focus { border-color:#f97316; box-shadow:0 0 0 3px rgba(249,115,22,.12); background:#fff; }
  .fr-toast { pointer-events:none; position:fixed; left:50%; top:64px; transform:translateX(-50%) translateY(-12px);
    background:linear-gradient(135deg,rgba(251,146,60,.95),rgba(249,115,22,.95)); color:#fff; padding:12px 18px; border-radius:12px; font-size:13px; max-width:80vw;
    opacity:0; transition:.25s; text-align:center; box-shadow:0 10px 30px rgba(249,115,22,.3); backdrop-filter:blur(10px); }
  .fr-toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
  .fr-toast .tip { display:block; margin-top:6px; font-size:12px; opacity:.9; }
  .fr-ent { pointer-events:auto; position:fixed; left:50%; bottom:24px; transform:translateX(-50%);
    background:#fff7ed; border:1px solid #fdba74; color:#9a3412; border-radius:13px; padding:10px 14px;
    font-size:13px; display:none; align-items:center; gap:12px; box-shadow:0 10px 28px rgba(0,0,0,.16); animation:fr-pop .2s ease; }
  .fr-ent button { border:none; border-radius:9px; padding:7px 13px; font-size:12px; cursor:pointer; font-weight:600; }
  .fr-ent .b1 { background:#ea580c; color:#fff; } .fr-ent .b2 { background:#ffedd5; color:#9a3412; }
  .fr-still { pointer-events:auto; position:fixed; left:50%; bottom:72px; transform:translateX(-50%);
    background:#f0f9ff; border:1px solid #7dd3fc; color:#075985; border-radius:13px; padding:10px 14px;
    font-size:13px; display:none; align-items:center; gap:12px; box-shadow:0 10px 28px rgba(0,0,0,.14); animation:fr-pop .2s ease; }
  .fr-still button { border:none; border-radius:9px; padding:7px 13px; font-size:12px; cursor:pointer; font-weight:600; }
  .fr-still .s1 { background:#0284c7; color:#fff; } .fr-still .s2 { background:#e0f2fe; color:#075985; }
  `;
  rootEl.innerHTML = `<style>${STYLE}</style>
  <div class="fr-root" id="frRoot">
    <div class="fr-ball" id="frBall" style="display:none">
      <div class="ring"><svg viewBox="0 0 40 40">
        <circle class="bg" cx="20" cy="20" r="16.5"></circle>
        <circle class="fg" id="ringFg" cx="20" cy="20" r="16.5"></circle>
      </svg></div>
      <div class="meta"><div class="t" id="frTime">25:00</div><div class="s" id="frState">专注中</div></div>
      <div class="fr-menu" id="frMenu"></div>
    </div>
    <div class="fr-mask" id="frMask"></div>
    <div class="fr-card" id="frCheckin">
      <button class="fr-close" id="frCheckinX">×</button>
      <h3>专注自检</h3><div class="q">刚才这段时间，你专注吗？</div>
      <div class="fr-row">
        <button class="fr-btn primary" id="btnYes">是，专注</button>
        <button class="fr-btn ghost" id="btnNo">否，走神了</button>
      </div>
    </div>
    <div class="fr-card" id="frRecover">
      <h3>把注意力收回来</h3>
      <div class="q">走神很正常，花几秒标记一下（均可跳过），然后回到任务。</div>
      <div class="fr-tags" id="frTags"></div>
      <input class="fr-input" id="frTask" placeholder="现在回到什么任务？（可跳过）" maxlength="40">
      <div class="fr-row"><button class="fr-btn primary" id="btnBack">回到专注</button></div>
    </div>
    <div class="fr-toast" id="frToast"></div>
    <div class="fr-ent" id="frEnt">
      <span id="frEntText"></span>
      <button class="b1" id="btnEntStudy">回到学习</button>
      <button class="b2" id="btnEntPass">本次放行</button>
    </div>
    <div class="fr-still" id="frStill">
      <span id="frStillText"></span>
      <button class="s1" id="btnStillOk">我在专注</button>
      <button class="s2" id="btnStillDistract">走神了，回收</button>
    </div>
  </div>`;
  // 把两张卡片移入遮罩，实现遮罩内居中
  const mask = rootEl.getElementById('frMask');
  ['frCheckin', 'frRecover'].forEach(id => mask.appendChild(rootEl.getElementById(id)));

  const $ = id => rootEl.getElementById(id);
  const root = $('frRoot');
  const ballEl = $('frBall');
  const RING_C = 2 * Math.PI * 16.5;
  $('ringFg').style.strokeDasharray = String(RING_C);
  // 立即把 Shadow 根挂到页面，避免 renderBall 时 host 还不在 DOM 中导致球“看不见”
  try { document.documentElement.appendChild(host); } catch (e) {}

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
  }
  function remainSec() {
    if (!session) return 0;
    if (session.state === 'RUNNING') return (session.endTs - Date.now()) / 1000;
    if (session.state === 'PAUSED') return session.plannedSec - session.elapsedSec;
    return 0;
  }
  const STATE_TEXT = { RUNNING: '专注中', PAUSED: '已暂停', CHECKIN: '待自检', RECOVER: '回收中' };

  function buildMenu(st) {
    const menu = $('frMenu'); menu.innerHTML = '';
    if (st === 'IDLE') return; // IDLE 时点击球直接开始专注，不需要菜单
    const mk = (txt, fn, danger) => { const b = document.createElement('button'); if (danger) b.className = 'danger'; b.textContent = txt; b.onclick = e => { e.stopPropagation(); ballEl.classList.remove('open'); fn(); }; return b; };
    if (st === 'RUNNING') {
      menu.appendChild(mk('暂停', () => send('SESSION_PAUSE')));
      menu.appendChild(mk('立即自检', () => send('CHECKIN_NOW')));
    } else if (st === 'PAUSED') {
      menu.appendChild(mk('继续', () => send('SESSION_RESUME')));
    }
    menu.appendChild(mk('结束本次', () => send('SESSION_END'), true));
    // 对齐时间：只拉取后台当前会话状态覆盖本地，时间连续不重置；连接失效时提示刷新网页
    menu.appendChild(mk('对齐时间', () => {
      send('CONTENT_READY').then(r => {
        if (r) {
          session = r.session; mode = r.mode || mode; soundOn = !!r.sound;
          renderBall();
          showToast('已同步', '时间已与后台对齐，未重置');
        } else {
          showToast('同步失败', '扩展连接已失效，请刷新网页（F5）', 'recover');
        }
      });
    }));
  }

  // 状态变化时调用：显示/隐藏 + 文案 + 菜单
  function renderBall() {
    assertMounted(); // v1.1.5: 确保Shadow DOM宿主已挂到页面，避免"悬浮窗没了"
    const st = session ? session.state : 'IDLE';
    ballEl.style.display = 'flex'; // IDLE 也显示，方便左键直接开始专注
    if (lastMenuState !== st) { buildMenu(st); lastMenuState = st; }
    if (st === 'IDLE') {
      $('frTime').textContent = '开始';
      $('frState').textContent = '未开始';
      $('ringFg').style.strokeDashoffset = String(RING_C); // 空环
      return;
    }
    $('frState').textContent = STATE_TEXT[st] || '';
    updateTimer();
  }
  // 每秒调用：只更新时间与进度环，并做“显示自愈”，不重建菜单
  function updateTimer() {
    if (!session || session.state === 'IDLE') { return; } // IDLE 由 renderBall 处理显示
    if (ballEl.style.display === 'none') ballEl.style.display = 'flex';
    const r = session.state === 'RUNNING' || session.state === 'PAUSED' ? remainSec() : session.plannedSec;
    // 异常检测：RUNNING 但剩余时间<=0，说明本地 session 过时，立即触发心跳对齐
    if (session.state === 'RUNNING' && r <= 0) heartbeat();
    $('frTime').textContent = fmt(r);
    const ratio = session.plannedSec ? Math.max(0, Math.min(1, r / session.plannedSec)) : 0;
    $('ringFg').style.strokeDashoffset = String(RING_C * (1 - ratio));
  }
  // 对齐到系统整秒刷新，确保与弹窗面板时间完全一致（消除差1秒问题）
  function alignedTick() {
    assertMounted();
    updateTimer();
    heartbeat();
    setTimeout(alignedTick, 1000 - (Date.now() % 1000));
  }
  alignedTick();

  // —— 挂载点自愈：被页面移除就重新挂回；全屏时挂到全屏容器内 ——
  function assertMounted() {
    const parent = document.fullscreenElement || document.documentElement;
    if (!parent.contains(host)) parent.appendChild(host);
  }
  try {
    new MutationObserver(assertMounted).observe(document.documentElement, { childList: true });
  } catch (e) {}
  window.addEventListener('pageshow', () => { assertMounted(); updateTimer(); heartbeat(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { updateTimer(); heartbeat(); } }); // 切回标签页立即对齐
  window.addEventListener('focus', () => { updateTimer(); heartbeat(); }); // 窗口获得焦点立即对齐

  // —— 悬浮球：点击展开 / 拖动 ——
  ballEl.addEventListener('mousedown', e => {
    dragMoved = false;
    dragStart = { x: e.clientX, y: e.clientY, rect: ballEl.getBoundingClientRect() };
  });
  document.addEventListener('mousemove', e => {
    if (!dragStart) return;
    if (Math.abs(e.clientX - dragStart.x) + Math.abs(e.clientY - dragStart.y) > 6) {
      dragMoved = true;
      const x = Math.max(0, Math.min(window.innerWidth - 60, dragStart.rect.left + (e.clientX - dragStart.x)));
      const y = Math.max(0, Math.min(window.innerHeight - 40, dragStart.rect.top + (e.clientY - dragStart.y)));
      ballEl.style.right = 'auto'; ballEl.style.left = x + 'px'; ballEl.style.top = y + 'px';
    }
  });
  document.addEventListener('mouseup', () => {
    if (dragStart && dragMoved) {
      const r = ballEl.getBoundingClientRect();
      uiPrefs.ballPos = { left: r.left, top: r.top };
      send('SET_UI_PREFS', { prefs: { ballPos: uiPrefs.ballPos } });
    }
    dragStart = null;
  });
  ballEl.addEventListener('click', () => {
    if (dragMoved) return;
    const st = session ? session.state : 'IDLE';
    if (st === 'IDLE') {
      send('SESSION_START'); // 左键直接开始专注，不用去任务栏点弹窗
      showToast('开始专注', '默认 25 分钟，可在弹窗面板调整时长');
    } else {
      ballEl.classList.toggle('open');
      heartbeat(); // 展开菜单时立即对齐一次，确保看到最新时间
    }
  });
  document.addEventListener('fullscreenchange', () => {
    root.classList.toggle('is-fullscreen', !!document.fullscreenElement);
    assertMounted(); // 进入全屏时把球挂到全屏容器，退出时挂回 documentElement
    if (document.fullscreenElement && session && session.state === 'RUNNING') {
      showToast('全屏模式', '悬浮球已尽量置顶；到点将通过系统通知提醒你', 'recover');
    }
  });

  // —— 自检 / 回收 浮层 ——
  function closeOverlays() { $('frMask').style.display = 'none'; selectedTag = null; $('frTask').value = ''; restoreTitle(); }
  function openCheckin() {
    $('frRecover').style.display = 'none'; $('frCheckin').style.display = 'block';
    $('frCheckinX').style.display = mode === 'strict' ? 'none' : 'block';
    mask.style.display = 'flex';
  }
  function openRecover() {
    selectedTag = null;
    const box = $('frTags'); box.innerHTML = '';
    DISTRACT_TAGS.forEach(t => {
      const c = document.createElement('span'); c.className = 'fr-tag'; c.textContent = t;
      c.onclick = () => {
        const on = c.classList.contains('on');
        box.querySelectorAll('.fr-tag').forEach(x => x.classList.remove('on'));
        if (!on) { c.classList.add('on'); selectedTag = t; } else selectedTag = null;
      };
      box.appendChild(c);
    });
    $('frCheckin').style.display = 'none'; $('frRecover').style.display = 'block'; mask.style.display = 'flex';
  }
  mask.addEventListener('click', e => { if (e.target === mask && mode !== 'strict') { send('ANSWER_SKIP'); closeOverlays(); } });
  $('frCheckinX').onclick = () => { send('ANSWER_SKIP'); closeOverlays(); };
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('frCheckin').style.display === 'block' && mode !== 'strict') { send('ANSWER_SKIP'); closeOverlays(); }
  });
  $('btnYes').onclick = async () => { await send('ANSWER_FOCUSED'); closeOverlays(); };
  $('btnNo').onclick = async () => { await send('ENTER_RECOVER'); openRecover(); };
  $('btnBack').onclick = async () => {
    await send('RECOVER_DONE', { tags: selectedTag ? [selectedTag] : [], taskText: $('frTask').value.trim() });
    closeOverlays();
  };

  // —— Toast 话术 ——
  let toastTimer = null;
  function showToast(text, tip, kind) {
    const t = $('frToast');
    t.innerHTML = text + (tip ? `<span class="tip">${tip}</span>` : '');
    t.style.background = kind === 'recover' ? 'rgba(120,53,15,.95)' : 'rgba(15,46,43,.94)';
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // —— 娱乐提醒横幅 ——
  $('btnEntStudy').onclick = () => { send('GOTO_STUDY'); $('frEnt').style.display = 'none'; };
  $('btnEntPass').onclick = () => { send('RELEASE_HOST', { host: location.hostname.replace(/^www\./, '') }); $('frEnt').style.display = 'none'; };
  function showEntertain(sec) {
    $('frEntText').textContent = `你已在娱乐站点停留约 ${Math.max(1, Math.round((sec || 0) / 60))} 分钟，要回到学习吗？`;
    $('frEnt').style.display = 'flex';
  }

  // —— 轻提示音（WebAudio，离线短音）——
  function beep() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      const ac = new AC();
      [0, 0.25].forEach(d => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.frequency.value = 660; o.connect(g); g.connect(ac.destination);
        g.gain.setValueAtTime(0.001, ac.currentTime + d);
        g.gain.exponentialRampToValueAtTime(0.12, ac.currentTime + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + d + 0.18);
        o.start(ac.currentTime + d); o.stop(ac.currentTime + d + 0.2);
      });
    } catch (e) { /* 手势策略限制时忽略 */ }
  }

  // 任务栏标题闪烁提醒：全屏时看不到浮层，靠标题闪烁+声音让用户感知到点
  let _originalTitle = document.title;
  let _titleTimer = null;
  function flashTitle(text) {
    if (_titleTimer) return;
    _originalTitle = document.title;
    let toggle = false;
    _titleTimer = setInterval(() => { document.title = toggle ? _originalTitle : text; toggle = !toggle; }, 800);
  }
  function restoreTitle() {
    if (_titleTimer) { clearInterval(_titleTimer); _titleTimer = null; }
    document.title = _originalTitle;
  }

  // —— 页面活跃度检测（不截屏）：视频在播 / DOM 在变 / 用户在操作，任一发生即“有活动” ——
  let lastMotionTs = Date.now();
  const markMotion = () => { lastMotionTs = Date.now(); };
  ['mousemove', 'keydown', 'click', 'scroll', 'wheel', 'touchstart'].forEach(ev =>
    window.addEventListener(ev, markMotion, { passive: true, capture: true }));
  try {
    const mo = new MutationObserver(markMotion);
    const obsBody = () => { if (document.body) mo.observe(document.body, { childList: true, subtree: true, characterData: true }); };
    if (document.body) obsBody(); else window.addEventListener('DOMContentLoaded', obsBody);
  } catch (e) {}
  setInterval(() => { // 页面内 <video> 的 currentTime 在增长，视为正在播放（听课/看演示）
    try {
      let progressing = false;
      document.querySelectorAll('video').forEach(v => {
        if (!v.paused && !v.ended && v.readyState > 2 && typeof v.__frLast === 'number' && v.currentTime > v.__frLast + 0.1) progressing = true;
        v.__frLast = v.currentTime;
      });
      if (progressing) markMotion();
    } catch (e) {}
  }, 4000);
  setInterval(() => { send('PAGE_PULSE', { stillSec: Math.floor((Date.now() - lastMotionTs) / 1000) }); }, 5000);
  $('btnStillOk').onclick = () => { send('STILL_OK'); $('frStill').style.display = 'none'; restoreTitle(); };
  $('btnStillDistract').onclick = async () => { $('frStill').style.display = 'none'; restoreTitle(); await send('STILL_DISTRACT'); };

  // —— 心跳：定期向后台重拉状态（SW 休眠/丢消息后可自愈）——
  function heartbeat() {
    assertMounted();
    send('CONTENT_READY').then(r => {
      if (r) { session = r.session; mode = r.mode || 'gentle'; soundOn = !!r.sound; renderBall(); }
      // 失败时静默：SW 可能临时休眠，下一次心跳会自愈，不做不可靠的"已更新"误报
    });
  }

  // —— 接收后台消息 ——
  chrome.runtime.onMessage.addListener(msg => {
    if (!msg || !msg.type) return;
    if (msg.type === 'STATE') {
      session = msg.session; if (msg.mode) mode = msg.mode; if (typeof msg.sound === 'boolean') soundOn = msg.sound;
      if (session && session.state === 'IDLE') closeOverlays();
      assertMounted(); renderBall();
    } else if (msg.type === 'SHOW_CHECKIN') {
      assertMounted();
      if (typeof msg.sound === 'boolean') soundOn = msg.sound;
      openCheckin();
      beep(); // 到点自检强制播放提示音，全屏时唯一可靠的听觉提醒
      flashTitle('⏰ 专注自检：刚才专注了吗？'); // 任务栏标题闪烁，全屏时用户切窗能看到
    } else if (msg.type === 'SHOW_ENTERTAIN') {
      assertMounted(); showEntertain(msg.sec);
    } else if (msg.type === 'SHOW_STILL') {
      assertMounted();
      const sc = msg.stillSec || 0;
      const span = sc >= 60 ? `约 ${Math.round(sc / 60)} 分钟` : `${sc} 秒`;
      $('frStillText').textContent = `页面已${span}没有变化，你走神了吗？`;
      $('frStill').style.display = 'flex';
      beep(); // v1.1.6: 走神提醒加提示音，确保全屏时也能听到
      flashTitle('⚠️ 检测到走神：页面已长时间无变化'); // v1.1.6: 标题闪烁，切窗时能看到
    } else if (msg.type === 'PHRASE_TOAST') {
      showToast(msg.text, msg.tip, msg.kind);
    }
  });

  // —— 监听 storage 变化：多页面实时同步（比 broadcast 和心跳更可靠，所有标签页立即收到） ——
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.session) return;
    session = changes.session.newValue;
    if (session && session.state === 'IDLE') closeOverlays();
    assertMounted(); renderBall();
  });

  // —— 初始化：位置 + 状态 ——
  try {
    chrome.storage.local.get('uiPrefs', v => {
      const p = v && v.uiPrefs;
      if (p) { uiPrefs = Object.assign(uiPrefs, p); if (p.ballPos) { ballEl.style.right = 'auto'; ballEl.style.left = p.ballPos.left + 'px'; ballEl.style.top = p.ballPos.top + 'px'; } }
    });
  } catch (e) {}
  renderBall(); // v1.1.5: 初始化时先显示悬浮球（IDLE状态），不依赖heartbeat成功，避免"悬浮窗没了"
  heartbeat();
})();
