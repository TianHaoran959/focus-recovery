/* popup.js —— 弹窗面板：会话控制 + 今日概览 + 小结 + L2 复制 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let session = null, settings = null, tick = null;

  function send(type, payload) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), res => {
          if (chrome.runtime.lastError) { resolve(null); return; } // background 未就绪时静默，不报 Unchecked lastError
          resolve(res);
        });
      } catch (e) { resolve(null); }
    });
  }
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0)); // v1.1.7: 统一用Math.floor，与content.js一致，消除差1秒
    return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
  }
  function remainSec() {
    if (!session) return 0;
    if (session.state === 'RUNNING') return (session.endTs - Date.now()) / 1000;
    if (session.state === 'PAUSED') return session.plannedSec - session.elapsedSec;
    return 0;
  }

  // 环形进度条渲染（v1.2.0）
  const RING_C = 2 * Math.PI * 52; // 圆周长 ≈ 326.7
  function renderRing() {
    const fg = $('ringFg');
    if (!fg) return;
    if (!session || session.state === 'IDLE') {
      fg.style.strokeDashoffset = String(RING_C); // 空环
      return;
    }
    const planned = session.plannedSec || 1;
    const elapsed = session.state === 'RUNNING'
      ? Math.min(planned, (Date.now() - session.startTs) / 1000 + (session.elapsedSec || 0))
      : (session.elapsedSec || 0);
    const ratio = Math.max(0, Math.min(1, elapsed / planned));
    fg.style.strokeDashoffset = String(RING_C * (1 - ratio));
  }

  // 本周专注曲线（v1.2.0）
  async function renderWeekChart() {
    const bars = $('weekBars');
    if (!bars) return;
    const dd = (await FR.get(FR.K.domainDaily, {})) || {};
    const days = [];
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const dayData = dd[key] && dd[key].domains ? dd[key].domains : {};
      let studySec = 0;
      Object.values(dayData).forEach(dom => { if (dom.cls === 'study') studySec += dom.sec || 0; });
      days.push({ key, label: ['日','一','二','三','四','五','六'][d.getDay()], min: Math.round(studySec / 60), isToday: i === 0 });
    }
    const maxMin = Math.max(1, ...days.map(d => d.min));
    const totalMin = days.reduce((sum, d) => sum + d.min, 0);
    $('weekTotal').textContent = `共 ${totalMin} 分钟`;
    bars.innerHTML = '';
    days.forEach(d => {
      const col = document.createElement('div');
      col.className = 'bar-col';
      const bar = document.createElement('div');
      bar.className = 'bar' + (d.isToday ? ' today' : '');
      bar.style.height = Math.max(3, (d.min / maxMin) * 44) + 'px';
      bar.title = `${d.key}：学习 ${d.min} 分钟`;
      const label = document.createElement('div');
      label.className = 'bar-label';
      label.textContent = d.label;
      col.appendChild(bar);
      col.appendChild(label);
      bars.appendChild(col);
    });
  }

  async function chosenMinutes() {
    const v = $('durSel').value;
    if (v === 'custom') return Math.min(180, Math.max(5, Number($('customMin').value) || settings.defaultDuration));
    return Number(v);
  }

  function renderControls() {
    const st = session ? session.state : 'IDLE';
    const line = $('ctrlLine'); line.innerHTML = '';
    const mk = (txt, cls, fn) => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = txt; b.onclick = fn; return b; };
    if (st === 'RUNNING') {
      line.appendChild(mk('暂停', 'ghost', () => send('SESSION_PAUSE')));
      line.appendChild(mk('结束', 'warn', () => send('SESSION_END')));
    } else if (st === 'PAUSED') {
      line.appendChild(mk('继续', 'primary', () => send('SESSION_RESUME')));
      line.appendChild(mk('结束', 'warn', () => send('SESSION_END')));
    } else if (st === 'CHECKIN' || st === 'RECOVER') {
      line.appendChild(mk('请到网页浮层完成自检', 'ghost', () => {}));
    } else {
      line.appendChild(mk('开始专注', 'primary', async () => send('SESSION_START', { durationMin: await chosenMinutes() })));
    }
    $('stateTxt').textContent = { IDLE: '未开始', RUNNING: '专注中', PAUSED: '已暂停', CHECKIN: '待自检（看网页浮层）', RECOVER: '走神回收中' }[st] || st;
  }

  function renderSummary(s) {
    if (!s) return;
    const blocks = (s.focused || 0) + (s.distracted || 0);
    $('kBlocks').textContent = `${blocks} / ${s.totalMin || 0}`;
    $('kRate').textContent = (s.focusRate === null || s.focusRate === undefined) ? '—' : s.focusRate + '%';
    $('kStudy').textContent = Math.round((s.studySec || 0) / 60) + '分';
    $('kFun').textContent = Math.round((s.entertainSec || 0) / 60) + '分';
  }

  function summaryText(s) {
    s = s || {};
    const focused = s.focused || 0, distracted = s.distracted || 0, skipped = s.skipped || 0;
    const L = [];
    L.push(`完成专注块：${focused + distracted}（专注 ${focused}/走神 ${distracted}/跳过 ${skipped}），累计 ${s.totalMin || 0} 分钟`);
    L.push(`自评专注率：${(s.focusRate === null || s.focusRate === undefined) ? '样本不足' : s.focusRate + '%'}`);
    L.push(`网站时长：学习 ${FR.fmtDur(s.studySec || 0)} / 娱乐 ${FR.fmtDur(s.entertainSec || 0)} / 其他 ${FR.fmtDur(s.neutralSec || 0)}`);
    if (s.peakHour != null) L.push(`走神高发时段：${s.peakHour}:00-${s.peakHour + 1}:00`);
    if (s.topTags && s.topTags.length) L.push('Top 走神类型：' + s.topTags.join('、'));
    L.push('\n口径：专注率=专注/(专注+走神)，跳过不计入；数据为本人自评，仅供自我观察。');
    return L.join('\n');
  }

  async function refresh() {
    const r = await send('GET_STATE');
    if (!r) return;
    session = r.session; renderControls(); renderSummary(r.summary); renderRing(); renderWeekChart();
  }

  async function init() {
    settings = await FR.get(FR.K.settings, FR.DEFAULT_SETTINGS);
    const sel = $('durSel');
    settings.durations.forEach(d => { const o = document.createElement('option'); o.value = d; o.textContent = d + ' 分钟'; sel.appendChild(o); });
    const oc = document.createElement('option'); oc.value = 'custom'; oc.textContent = '自定义'; sel.appendChild(oc);
    sel.value = String(settings.defaultDuration);
    $('customMin').value = settings.customDuration || settings.defaultDuration;
    sel.onchange = () => { $('customMin').style.display = sel.value === 'custom' ? 'inline-block' : 'none'; };

    $('btnSummary').onclick = async () => {
      const box = $('summary');
      if (box.style.display === 'block') { box.style.display = 'none'; return; }
      const r = await send('GET_SUMMARY'); box.textContent = summaryText(r.summary); box.style.display = 'block';
    };
    $('btnCopy').onclick = async () => {
      const r = await send('COPY_PACK');
      const btn = $('btnCopy');
      const done = () => { btn.textContent = '已复制，去粘贴给豆包'; setTimeout(() => btn.textContent = '复制复盘包', 2500); };
      try { await navigator.clipboard.writeText(r.text); done(); }
      catch (e) { // 兜底：临时文本框
        const ta = document.createElement('textarea'); ta.value = r.text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (e2) { alert('复制失败，请手动选择文本'); }
        ta.remove();
      }
    };
    $('btnOptions').onclick = () => chrome.runtime.openOptionsPage();
    $('btnReloadAll').onclick = async () => {
      if (!confirm('将刷新所有打开的标签页，正在播放的视频/填写的表单可能中断。确定继续？')) return;
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) chrome.tabs.reload(t.id).catch(() => {});
      window.close();
    };

    await refresh();
    // 对齐到系统整秒刷新，确保与悬浮球时间完全一致（消除差1秒问题）
    function alignedTick() {
      if (session && (session.state === 'RUNNING' || session.state === 'PAUSED')) {
        $('remain').textContent = fmt(remainSec());
        renderRing();
      }
      setTimeout(alignedTick, 1000 - (Date.now() % 1000));
    }
    alignedTick();
    setInterval(refresh, 5000);
  }
  init();
})();
