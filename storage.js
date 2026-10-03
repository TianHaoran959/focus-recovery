/*
 * storage.js —— 统一数据层（被 service worker（importScripts）与 popup/options（script 标签）共用）
 * 全部数据仅存于 chrome.storage.local，零网络请求。
 */
(function (global) {
  'use strict';

  const K = {
    settings: 'settings',
    session: 'session',
    checkpoints: 'checkpoints',
    domainDaily: 'domainDaily',
    phrases: 'phrases',
    uiPrefs: 'uiPrefs',
    lastPhrase: 'lastPhrase'
  };

  const DEFAULT_SETTINGS = {
    defaultDuration: 25,      // 默认档位（分钟）
    durations: [25, 30, 45, 60, 90], // v1.2.0: 加90分钟超日节律档位
    customDuration: 25,       // 自定义档位
    systemNotify: true,       // 系统通知
    sound: false,             // 提示音（默认关）
    trackScope: 'session',    // 网站统计范围：session=仅专注会话 / always=全天
    idleSec: 60,              // 多少秒无操作判空闲
    entertainRemind: true,    // 娱乐站温和提醒
    entertainThresholdSec: 120, // 娱乐站累计多少秒提醒
    mode: 'gentle',           // gentle=温和可跳过 / strict=严格必答
    relaxAfterBlocks: 0,      // 连续几块提示微休息，0=关闭
    stillDetect: true,        // 页面静止/疑似离开检测（视频推进+DOM变化+交互 三信号融合，不截屏）
    stillIdleSec: 45,         // 页面连续静止多少秒视为“非有效”，该段不计入网站有效时长
    stillWarnSec: 90          // 页面连续静止多少秒给一次温和提醒（仅专注会话中）
  };

  const DEFAULT_SESSION = {
    state: 'IDLE',            // IDLE/RUNNING/PAUSED/CHECKIN/RECOVER
    startTs: 0,               // 当前块开始时间戳
    plannedSec: 0,            // 当前块计划秒数
    elapsedSec: 0,            // PAUSED 时已累计秒
    currentBlock: 0,          // 今日已开始的块序号
    durationMin: 25,
    endTs: 0,                 // 当前块计划到期时间戳（供 UI 倒计时）
    lastTickTs: 0,            // 网站统计上次对齐时间
    entertainSec: {},         // 本会话各娱乐 host 累计秒
    remindedHosts: [],        // 本会话已提醒过的 host
    lastStudyTabId: null      // 最近的学习类标签（用于“回到学习”）
  };

  // 预置分类（保守：可能用于学习的 B站/YouTube 默认中性，交给用户判定）
  const PRESET_STUDY = ['xet.pomoho.com', 'icve168.com', 'chaoxing.com', 'zhihuishan.com'];
  const PRESET_ENTERTAIN = [
    'douyin.com', 'kuaishou.com', 'weibo.com', 'xiaohongshu.com', 'youku.com',
    'iqiyi.com', 'mgtv.com', 'douyu.com', 'huya.com', 'bilibili.tv',
    'tiktok.com', 'netflix.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com'
  ];

  const DEFAULT_PHRASES = {
    encourage: [
      '做得不错，保持这个节奏', '刚刚这段很稳，继续', '一次完整的专注，收下', '状态在线，乘胜追击',
      '把这份专注延续到下一段', '不错，你正在训练自己的注意力', '稳稳完成，给自己一个肯定', '节奏没断，继续',
      '这一段质量很高', '专注是可以练出来的，你正在变强', '又拿下一段，慢慢来会更快', '心流出现了，别停'
    ],
    recover: [
      '没关系，觉察到走神就是进步', '走神很正常，现在回来就好', '不责怪自己，轻轻把注意力拉回来',
      '看见分心，就已经赢了一半', '先深呼吸一次，再回到当前任务', '把注意力放回屏幕，就从这一秒开始',
      '不用焦虑，重新开始这一段', '分心被你抓到了，回到任务吧', '一次只做一件事，先做眼前这件',
      '允许自己走神，也允许自己回来', '把杂念先放下，等休息时再想', '回到当下，你可以的'
    ]
  };

  function todayKey(ts) {
    const d = new Date(ts || Date.now());
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  // 从 URL 取 host（只保留 host，不记录路径与查询串）
  function hostOf(url) {
    try {
      if (!url || !/^https?:/i.test(url)) return null;
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (e) { return null; }
  }

  function matchPreset(host, list) {
    if (!host) return false;
    return list.some(d => host === d || host.endsWith('.' + d));
  }

  // 初始分类：用户已分类优先，否则按预置，否则中性
  function presetClass(host) {
    if (matchPreset(host, PRESET_STUDY)) return 'study';
    if (matchPreset(host, PRESET_ENTERTAIN)) return 'entertain';
    return 'neutral';
  }

  async function get(key, fallback) {
    return new Promise(resolve => {
      chrome.storage.local.get(key, res => resolve(res[key] === undefined ? fallback : res[key]));
    });
  }
  async function set(key, value) {
    return new Promise(resolve => chrome.storage.local.set({ [key]: value }, resolve));
  }

  // 首次安装/升级时补齐缺失数据，不覆盖已有
  async function ensure() {
    const all = await new Promise(r => chrome.storage.local.get(null, r));
    const patch = {};
    if (!all[K.settings]) patch[K.settings] = { ...DEFAULT_SETTINGS };
    else patch[K.settings] = { ...DEFAULT_SETTINGS, ...all[K.settings] };
    if (!all[K.session]) patch[K.session] = { ...DEFAULT_SESSION };
    if (!all[K.checkpoints]) patch[K.checkpoints] = [];
    if (!all[K.domainDaily]) patch[K.domainDaily] = {};
    if (!all[K.phrases]) patch[K.phrases] = { ...DEFAULT_PHRASES };
    else patch[K.phrases] = {
      encourage: all[K.phrases].encourage || DEFAULT_PHRASES.encourage,
      recover: all[K.phrases].recover || DEFAULT_PHRASES.recover
    };
    if (!all[K.uiPrefs]) patch[K.uiPrefs] = { ballPos: null, opacity: 0.92 };
    if (!all.hostClass) patch.hostClass = {};
    if (!all[K.lastPhrase]) patch[K.lastPhrase] = { enc: null, rec: null };
    await new Promise(r => chrome.storage.local.set(patch, r));
    return patch;
  }

  async function addCheckpoint(cp) {
    const list = (await get(K.checkpoints, [])) || [];
    list.push(cp);
    await set(K.checkpoints, list);
    return cp;
  }

  // 累加某域名当日停留秒数
  async function bumpDomain(host, sec, clsOverride) {
    if (!host || sec <= 0) return;
    const dd = (await get(K.domainDaily, {})) || {};
    const dk = todayKey();
    if (!dd[dk]) dd[dk] = { domains: {} };
    if (!dd[dk].domains[host]) {
      dd[dk].domains[host] = { sec: 0, cls: clsOverride || presetClass(host) };
    }
    if (clsOverride) dd[dk].domains[host].cls = clsOverride;
    dd[dk].domains[host].sec += sec;
    await set(K.domainDaily, dd);
    return dd[dk].domains[host];
  }

  // 随机话术，避免与上一条重复
  async function randomPhrase(type) {
    const phrases = (await get(K.phrases, DEFAULT_PHRASES)) || DEFAULT_PHRASES;
    const last = (await get(K.lastPhrase, {})) || {};
    const arr = phrases[type] || [];
    if (!arr.length) return '';
    let idx = Math.floor(Math.random() * arr.length);
    const lastIdx = type === 'encourage' ? last.enc : last.rec;
    if (arr.length > 1 && idx === lastIdx) idx = (idx + 1) % arr.length;
    last[type === 'encourage' ? 'enc' : 'rec'] = idx;
    await set(K.lastPhrase, last);
    return arr[idx];
  }

  // —— 统计：纯函数，输入全量数据，输出今日小结 ——
  function summarize(data) {
    const dk = todayKey();
    const cps = (data.checkpoints || []).filter(c => todayKey(c.tsEnd) === dk);
    let focused = 0, distracted = 0, skipped = 0, totalMin = 0;
    const hourDistract = {}; const tagCount = {};
    cps.forEach(c => {
      if (c.result === 'focused') { focused++; totalMin += c.durationMin || 0; }
      else if (c.result === 'distracted') {
        distracted++; totalMin += c.durationMin || 0;
        const h = new Date(c.tsEnd).getHours();
        hourDistract[h] = (hourDistract[h] || 0) + 1;
        (c.distractTags || []).forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; });
      } else if (c.result === 'skipped') { skipped++; }
    });
    const answered = focused + distracted;
    const focusRate = answered ? Math.round((focused / answered) * 100) : null;
    const today = (data.domainDaily || {})[dk];
    const sec = { study: 0, entertain: 0, neutral: 0 };
    if (today && today.domains) {
      Object.values(today.domains).forEach(d => { sec[d.cls || 'neutral'] += d.sec || 0; });
    }
    const peakHour = Object.keys(hourDistract).sort((a, b) => hourDistract[b] - hourDistract[a])[0];
    const topTags = Object.keys(tagCount).sort((a, b) => tagCount[b] - tagCount[a]).slice(0, 3);
    return {
      date: dk, focused, distracted, skipped, totalMin, focusRate,
      studySec: sec.study, entertainSec: sec.entertain, neutralSec: sec.neutral,
      peakHour: peakHour === undefined ? null : Number(peakHour), topTags, checkpoints: cps
    };
  }

  function fmtDur(sec) {
    sec = Math.round(sec || 0);
    if (sec < 60) return sec + '秒';
    const m = Math.floor(sec / 60), s = sec % 60;
    return s ? `${m}分${s}秒` : `${m}分钟`;
  }

  const L2_PROMPT =
    '你是我的专注力教练。下面是我今天用“专注回收”工具导出的结构化记录（自评数据，可能不完整）。请你：\n' +
    '1) 用简洁中文输出“今日专注小结”：完成情况、专注率、学习与娱乐时间对比；\n' +
    '2) 指出最值得注意的 1–2 个规律（如走神高发时段、最常见走神类型），只基于我给的数据，不要编造缺失信息；数据不足就明确说“样本不足”；\n' +
    '3) 给出 3 条具体、可执行、低成本的明日改进建议（结合我在电脑看课时容易走神、正在戒手机的背景）；\n' +
    '4) 最后给一句温和、不打鸡血的鼓励。输出 300 字以内、分点、不做夸张疗效承诺。\n' +
    '以下是我的数据：\n';

  // 生成 L2 一键复制复盘包
  function buildL2Pack(data) {
    const s = summarize(data);
    const lines = [];
    lines.push('【专注回收 · 今日数据摘要】');
    lines.push('日期：' + s.date);
    lines.push(`完成专注块：${s.focused + s.distracted}（专注 ${s.focused} / 走神 ${s.distracted} / 跳过 ${s.skipped}），累计 ${s.totalMin} 分钟`);
    lines.push('自评专注率：' + (s.focusRate === null ? '样本不足' : s.focusRate + '%'));
    lines.push(`网站时长：学习 ${fmtDur(s.studySec)} / 娱乐 ${fmtDur(s.entertainSec)} / 其他 ${fmtDur(s.neutralSec)}`);
    if (s.peakHour !== null) lines.push(`走神高发时段：${s.peakHour}:00-${s.peakHour + 1}:00`);
    if (s.topTags.length) lines.push('Top 走神类型：' + s.topTags.join('、'));
    lines.push('明细：');
    s.checkpoints.forEach((c, i) => {
      const t = new Date(c.tsEnd);
      const hh = String(t.getHours()).padStart(2, '0'), mm = String(t.getMinutes()).padStart(2, '0');
      const tags = (c.distractTags || []).join('|');
      lines.push(`  ${i + 1}. ${hh}:${mm} ${c.durationMin}分钟 结果=${c.result}${tags ? ' 标签=' + tags : ''}${c.taskText ? ' 任务=' + c.taskText : ''}`);
    });
    return lines.join('\n') + '\n\n【分析提示词】\n' + L2_PROMPT;
  }

  async function exportAll() {
    return new Promise(r => chrome.storage.local.get(null, r));
  }
  async function clearAll() {
    return new Promise(r => chrome.storage.local.clear(r));
  }

  global.FR = {
    K, DEFAULT_SETTINGS, DEFAULT_SESSION, DEFAULT_PHRASES, PRESET_STUDY, PRESET_ENTERTAIN,
    todayKey, hostOf, presetClass, get, set, ensure, addCheckpoint, bumpDomain,
    randomPhrase, summarize, fmtDur, buildL2Pack, L2_PROMPT, exportAll, clearAll
  };
})(typeof self !== 'undefined' ? self : window);
