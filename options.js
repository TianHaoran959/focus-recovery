/* options.js —— 设置页：参数 / 话术 / 域名分类 / 数据管理 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let hostClass = {};

  async function load() {
    await FR.ensure();
    const s = await FR.get(FR.K.settings, FR.DEFAULT_SETTINGS);
    const ph = await FR.get(FR.K.phrases, FR.DEFAULT_PHRASES);
    hostClass = (await FR.get('hostClass', {})) || {};

    const sel = $('defaultDuration');
    s.durations.forEach(d => { const o = document.createElement('option'); o.value = d; o.textContent = d + ' 分钟'; sel.appendChild(o); });
    sel.value = String(s.defaultDuration);
    $('customDuration').value = s.customDuration;
    $('relaxAfterBlocks').value = s.relaxAfterBlocks;
    $('systemNotify').checked = !!s.systemNotify;
    $('sound').checked = !!s.sound;
    $('mode').value = s.mode;
    $('trackScope').value = s.trackScope;
    $('idleSec').value = s.idleSec;
    $('entertainRemind').checked = !!s.entertainRemind;
    $('entertainThresholdSec').value = s.entertainThresholdSec;
    $('stillDetect').checked = s.stillDetect !== false;
    $('stillIdleSec').value = s.stillIdleSec || 45;
    $('stillWarnSec').value = s.stillWarnSec || 90;
    $('phEnc').value = (ph.encourage || []).join('\n');
    $('phRec').value = (ph.recover || []).join('\n');
    renderHosts();
  }

  async function renderHosts() {
    // 合并“今日已出现域名”与“手动分类”
    const dd = (await FR.get(FR.K.domainDaily, {})) || {};
    const seen = new Set(Object.keys(hostClass));
    Object.values(dd).forEach(day => { if (day && day.domains) Object.keys(day.domains).forEach(h => seen.add(h)); });
    const list = $('hostList'); list.innerHTML = '';
    const hosts = Array.from(seen).sort();
    if (!hosts.length) list.innerHTML = '<div class="note">暂无记录，使用一段时间后会自动出现访问过的域名。</div>';
    hosts.forEach(h => {
      const cur = hostClass[h] || FR.presetClass(h);
      const row = document.createElement('div'); row.className = 'host-row';
      const name = document.createElement('span'); name.className = 'h'; name.textContent = h;
      const cs = document.createElement('select');
      [['study', '学习'], ['entertain', '娱乐'], ['neutral', '中性']].forEach(([v, t]) => {
        const o = document.createElement('option'); o.value = v; o.textContent = t; if (v === cur) o.selected = true; cs.appendChild(o);
      });
      cs.onchange = () => { hostClass[h] = cs.value; };
      row.appendChild(name); row.appendChild(cs); list.appendChild(row);
    });
  }

  async function save() {
    const cur = await FR.get(FR.K.settings, FR.DEFAULT_SETTINGS);
    const next = Object.assign({}, cur, {
      defaultDuration: Number($('defaultDuration').value),
      customDuration: Number($('customDuration').value) || 25,
      relaxAfterBlocks: Number($('relaxAfterBlocks').value) || 0,
      systemNotify: $('systemNotify').checked,
      sound: $('sound').checked,
      mode: $('mode').value,
      trackScope: $('trackScope').value,
      idleSec: Number($('idleSec').value) || 60,
      entertainRemind: $('entertainRemind').checked,
      entertainThresholdSec: Number($('entertainThresholdSec').value) || 120,
      stillDetect: $('stillDetect').checked,
      stillIdleSec: Number($('stillIdleSec').value) || 45,
      stillWarnSec: Number($('stillWarnSec').value) || 90
    });
    await FR.set(FR.K.settings, next);
    await FR.set(FR.K.phrases, {
      encourage: $('phEnc').value.split('\n').map(x => x.trim()).filter(Boolean),
      recover: $('phRec').value.split('\n').map(x => x.trim()).filter(Boolean)
    });
    await FR.set('hostClass', hostClass);
    const tip = $('savedTip'); tip.style.opacity = 1; setTimeout(() => tip.style.opacity = 0, 1500);
  }

  function download(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function bind() {
    $('btnSave').onclick = save;
    $('btnAddHost').onclick = () => {
      let h = $('newHost').value.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
      if (!h) return;
      hostClass[h] = $('newCls').value; $('newHost').value = ''; renderHosts();
    };
    $('btnExport').onclick = async () => {
      const data = await FR.exportAll();
      download('focus-recovery-backup-' + FR.todayKey() + '.json', JSON.stringify(data, null, 2));
    };
    $('btnImport').onclick = () => $('importFile').click();
    $('importFile').onchange = e => {
      const f = e.target.files[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const obj = JSON.parse(rd.result);
          if (typeof obj !== 'object') throw new Error('bad');
          chrome.storage.local.set(obj, () => { alert('导入成功，设置将刷新'); location.reload(); });
        } catch (err) { alert('文件不是有效的备份 JSON'); }
      };
      rd.readAsText(f);
    };
    $('btnClear').onclick = () => {
      if (!confirm('确定清空全部专注记录与设置？此操作不可恢复。')) return;
      if (!confirm('再次确认：真的要清空全部数据吗？')) return;
      FR.clearAll(() => {}).then(async () => { await FR.ensure(); location.reload(); });
    };
  }

  bind(); load();
})();
