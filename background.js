/*
 * background.js —— Service Worker：会话状态机 / alarms 权威计时 / 网站时长统计 / 娱乐检测 / 通知 / 消息中枢
 * 设计要点：MV3 的 SW 会被随时回收，所有权威状态写入 chrome.storage.local，计时用绝对时间戳 + chrome.alarms，
 *           绝不用内存 setInterval 当权威时钟；SW 重启后按时间戳恢复或结算。
 */
importScripts('storage.js');

const ALARM_TIMER = 'fr-timer';   // 当前专注块到期
const ALARM_TICK = 'fr-tick';     // 网站统计对齐（周期触发，按真实时间差累计，休眠不漂）
const pageStill = {};             // tabId -> 页面已静止秒数（content 每 5 秒上报，SW 内存态，重启后由上报重建）
const stillAck = {};              // tabId -> 用户点“我在专注”的时间戳（提醒冷却用）

// ———————————————— 基础工具 ————————————————
async function getSession() { return (await FR.get(FR.K.session)) || { ...FR.DEFAULT_SESSION }; }
async function setSession(s) { await FR.set(FR.K.session, s); }
async function getSettings() { return { ...FR.DEFAULT_SETTINGS, ...((await FR.get(FR.K.settings)) || {}) }; }

// 向所有标签的 content script 广播（无 content 的特殊页报错直接忽略）
async function broadcast(msg) {
  const settings = await getSettings();
  msg.sound = settings.sound;
  msg.mode = settings.mode;
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(t => chrome.tabs.sendMessage(t.id, msg).catch(() => {})));
}
async function sendToActiveTab(msg) {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs && tabs[0]) await chrome.tabs.sendMessage(tabs[0].id, msg).catch(() => {});
}

async function notify(title, message) {
  const settings = await getSettings();
  if (!settings.systemNotify) return;
  try {
    await chrome.notifications.create('fr-' + Date.now(), {
      type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 1
    });
  } catch (e) { /* 通知权限被拒时静默，页面浮层仍是底座 */ }
}

// ———————————————— 会话状态机 ————————————————
async function startBlock(durationMin, isNext) {
  const now = Date.now();
  const s = await getSession();
  s.state = 'RUNNING';
  s.startTs = now;
  s.elapsedSec = 0;
  s.durationMin = durationMin;
  s.plannedSec = durationMin * 60;
  s.endTs = now + s.plannedSec * 1000;
  s.lastTickTs = now;
  if (!isNext) { s.currentBlock = 1; s.entertainSec = {}; s.remindedHosts = []; }
  else { s.currentBlock = (s.currentBlock || 0) + 1; } // 进入下一块，序号 +1
  await setSession(s);
  await chrome.alarms.clear(ALARM_TIMER);
  await chrome.alarms.create(ALARM_TIMER, { when: s.endTs });
  await broadcast({ type: 'STATE', session: s });
}

async function pauseSession() {
  const s = await getSession();
  if (s.state !== 'RUNNING') return;
  s.elapsedSec += Math.floor((Date.now() - s.startTs) / 1000);
  s.state = 'PAUSED';
  await chrome.alarms.clear(ALARM_TIMER);
  await setSession(s);
  await broadcast({ type: 'STATE', session: s });
}

async function resumeSession() {
  const s = await getSession();
  if (s.state !== 'PAUSED') return;
  const now = Date.now();
  s.startTs = now;
  s.state = 'RUNNING';
  s.endTs = now + (s.plannedSec - s.elapsedSec) * 1000;
  await chrome.alarms.create(ALARM_TIMER, { when: s.endTs });
  await setSession(s);
  await broadcast({ type: 'STATE', session: s });
}

async function endSession() {
  await chrome.alarms.clear(ALARM_TIMER);
  const fresh = { ...FR.DEFAULT_SESSION, lastTickTs: Date.now() };
  await setSession(fresh);
  await broadcast({ type: 'STATE', session: fresh });
}

async function enterCheckin() {
  const s = await getSession();
  if (s.state !== 'RUNNING' && s.state !== 'CHECKIN') return;
  s.state = 'CHECKIN';
  await chrome.alarms.clear(ALARM_TIMER);
  await setSession(s);
  await broadcast({ type: 'STATE', session: s });
  await sendToActiveTab({ type: 'SHOW_CHECKIN' });
  await notify('专注自检', '刚才这段时间，你专注吗？');
}

// 记录一个检查点
async function recordCheckpoint(result, extra) {
  const s = await getSession();
  const now = Date.now();
  const cp = {
    id: 'cp-' + now + '-' + Math.floor(Math.random() * 1000),
    tsStart: s.startTs || (now - s.durationMin * 60000),
    tsEnd: now,
    durationMin: s.durationMin,
    result, // focused / distracted / skipped
    distractTags: (extra && extra.tags) || [],
    taskText: (extra && extra.taskText) || '',
    idleSec: 0
  };
  await FR.addCheckpoint(cp);
  return { cp, s };
}

async function answerFocused() {
  const settings = await getSettings();
  const { s } = await recordCheckpoint('focused');
  const phrase = await FR.randomPhrase('encourage');
  let tip = '';
  if (settings.relaxAfterBlocks > 0 && (s.currentBlock % settings.relaxAfterBlocks === 0)) {
    tip = `已连续专注 ${s.currentBlock} 块，建议起身活动 1–2 分钟、远眺放松。`;
  }
  await sendToActiveTab({ type: 'PHRASE_TOAST', kind: 'encourage', text: phrase, tip });
  await startBlock(s.durationMin, true);
  return { ok: true };
}

async function enterRecover() {
  const s = await getSession();
  if (s.state !== 'CHECKIN') return;
  s.state = 'RECOVER';
  await chrome.alarms.clear(ALARM_TIMER);
  await setSession(s);
  await broadcast({ type: 'STATE', session: s });
}

async function recoverDone(payload) {
  const { s } = await recordCheckpoint('distracted', payload || {});
  const phrase = await FR.randomPhrase('recover');
  await sendToActiveTab({ type: 'PHRASE_TOAST', kind: 'recover', text: phrase });
  await startBlock(s.durationMin, true);
  return { ok: true };
}

async function answerSkip() {
  const settings = await getSettings();
  if (settings.mode === 'strict') return { ok: false, reason: 'strict' }; // 严格模式必须回答
  const { s } = await recordCheckpoint('skipped');
  await startBlock(s.durationMin, true);
  return { ok: true };
}

// ———————————————— 网站时长统计 + 娱乐检测（tick） ————————————————
async function tick() {
  const now = Date.now();
  const settings = await getSettings();
  const s = await getSession();
  const last = s.lastTickTs || now;
  let delta = Math.floor((now - last) / 1000);
  s.lastTickTs = now;
  if (delta > 60) delta = 60;   // SW 长时间休眠后的首次对齐，钳制到一个周期，避免误加巨量时长
  if (delta < 1) { await setSession(s); return; }

  const scopeOn = settings.trackScope === 'always' || s.state === 'RUNNING';
  if (scopeOn) {
    const idleState = await new Promise(r => chrome.idle.queryState(settings.idleSec, r));
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs && tabs[0];
    const host = tab ? FR.hostOf(tab.url) : null;
    const stillSec = tab ? (pageStill[tab.id] || 0) : 0;
    const pageActive = !settings.stillDetect || stillSec < settings.stillIdleSec;

    // —— 网站有效时长统计 + 娱乐提醒：需要人在电脑前（idle active）且页面活跃 ——
    if (idleState === 'active' && host) {
      // 分类优先级：用户手动分类(hostClass) > 今日已记录分类 > 预置分类
      const hostClass = (await FR.get('hostClass', {})) || {};
      const dd = (await FR.get(FR.K.domainDaily, {})) || {};
      const dk = FR.todayKey();
      const existed = dd[dk] && dd[dk].domains[host];
      const cls = hostClass[host] || (existed && existed.cls) || FR.presetClass(host);
      // 页面长时间静止（疑似离开）不计入有效时长，避免“挂着人走了”虚增学习时间
      if (pageActive) {
        await FR.bumpDomain(host, delta, cls);
        if (cls === 'study') s.lastStudyTabId = tab.id;
      }

      // 娱乐站温和提醒（仅专注会话中、每会话每域名一次）
      if (pageActive && s.state === 'RUNNING' && settings.entertainRemind && cls === 'entertain') {
        s.entertainSec = s.entertainSec || {};
        s.entertainSec[host] = (s.entertainSec[host] || 0) + delta;
        if (!s.remindedHosts.includes(host) && s.entertainSec[host] >= settings.entertainThresholdSec) {
          s.remindedHosts.push(host);
          await chrome.tabs.sendMessage(tab.id, {
            type: 'SHOW_ENTERTAIN', host, sec: s.entertainSec[host]
          }).catch(() => {});
          notify('温柔提醒', `你已在娱乐站点停留约 ${Math.round(s.entertainSec[host] / 60)} 分钟，要回到学习吗？`);
        }
      }
    }

    // —— 静止 / 疑似离开温和提醒：独立于 idle active（静止时 idle 必然非 active，否则永远触发不了）——
    if (host && s.state === 'RUNNING' && settings.stillDetect && !pageActive && stillSec >= settings.stillWarnSec) {
      const cool = settings.stillWarnSec * 1000;
      const ackTs = stillAck[tab.id] || 0;
      if (now - (s.stillWarnTs || 0) >= cool && now - ackTs >= cool) {
        s.stillWarnTs = now;
        await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_STILL', stillSec }).catch(() => {});
        notify('专注确认', '页面已一段时间没有变化，你还在专注吗？');
      }
    }
  }
  await setSession(s);
}

// ———————————————— SW 休眠/重启恢复 ————————————————
async function restore() {
  await FR.ensure();
  await chrome.alarms.create(ALARM_TICK, { periodInMinutes: 0.5 });
  const s = await getSession();
  s.lastTickTs = Date.now();
  await setSession(s);
  if (s.state === 'RUNNING') {
    if (s.endTs && Date.now() >= s.endTs) await enterCheckin();
    else await chrome.alarms.create(ALARM_TIMER, { when: s.endTs });
  } else if (s.state === 'CHECKIN' || s.state === 'RECOVER') {
    await enterCheckin();
  }
}

// ———————————————— 事件绑定 ————————————————
chrome.runtime.onInstalled.addListener(async (details) => {
  await FR.ensure();
  await chrome.alarms.create(ALARM_TICK, { periodInMinutes: 0.5 });
  // 仅首次安装才重置会话；扩展更新/浏览器更新时保留进行中的会话并恢复，避免悬浮球无故消失
  if ((details && details.reason) === 'install') {
    await setSession({ ...FR.DEFAULT_SESSION, lastTickTs: Date.now() });
  } else {
    await restore();
  }
});
chrome.runtime.onStartup.addListener(restore);

chrome.alarms.onAlarm.addListener(async alarm => {
  try {
    if (alarm.name === ALARM_TIMER) await enterCheckin();
    else if (alarm.name === ALARM_TICK) await tick();
  } catch (e) { console.warn('[FR] alarm error', e); }
});

chrome.notifications.onClicked.addListener(async () => {
  const s = await getSession();
  if (s.state === 'CHECKIN') await sendToActiveTab({ type: 'SHOW_CHECKIN' });
});

// 消息中枢
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'SESSION_START':
          await startBlock(Number(msg.durationMin) || (await getSettings()).defaultDuration, false);
          sendResponse({ ok: true }); break;
        case 'SESSION_PAUSE': await pauseSession(); sendResponse({ ok: true }); break;
        case 'SESSION_RESUME': await resumeSession(); sendResponse({ ok: true }); break;
        case 'SESSION_END': await endSession(); sendResponse({ ok: true }); break;
        case 'CHECKIN_NOW': await enterCheckin(); sendResponse({ ok: true }); break;
        case 'ANSWER_FOCUSED': sendResponse(await answerFocused()); break;
        case 'ENTER_RECOVER': await enterRecover(); sendResponse({ ok: true }); break;
        case 'RECOVER_DONE': sendResponse(await recoverDone(msg)); break;
        case 'ANSWER_SKIP': sendResponse(await answerSkip()); break;
        case 'PAGE_PULSE':
          if (sender && sender.tab && sender.tab.id != null) pageStill[sender.tab.id] = Number(msg.stillSec) || 0;
          sendResponse({ ok: true }); break;
        case 'STILL_OK':
          if (sender && sender.tab && sender.tab.id != null) { stillAck[sender.tab.id] = Date.now(); pageStill[sender.tab.id] = 0; }
          sendResponse({ ok: true }); break;
        case 'STILL_DISTRACT':
          await enterCheckin(); sendResponse({ ok: true }); break;
        case 'RELEASE_HOST': {
          const s = await getSession();
          if (msg.host && !s.remindedHosts.includes(msg.host)) s.remindedHosts.push(msg.host);
          await setSession(s); sendResponse({ ok: true }); break;
        }
        case 'GOTO_STUDY': {
          const s = await getSession();
          if (s.lastStudyTabId != null) {
            await chrome.tabs.update(s.lastStudyTabId, { active: true }).catch(() => {});
          }
          sendResponse({ ok: true }); break;
        }
        case 'SET_UI_PREFS': {
          const ui = (await FR.get(FR.K.uiPrefs)) || {};
          await FR.set(FR.K.uiPrefs, { ...ui, ...msg.prefs });
          sendResponse({ ok: true }); break;
        }
        case 'CONTENT_READY': {
          const s = await getSession();
          const settings = await getSettings();
          sendResponse({ session: s, mode: settings.mode, sound: settings.sound });
          break;
        }
        case 'GET_STATE': {
          const s = await getSession();
          const data = await FR.exportAll();
          sendResponse({ session: s, summary: FR.summarize(data) });
          broadcast({ type: 'STATE', session: s }).catch(() => {}); // 打开弹窗即让各页悬浮球重显
          break;
        }
        case 'GET_SUMMARY': {
          sendResponse({ summary: FR.summarize(await FR.exportAll()) }); break;
        }
        case 'COPY_PACK': {
          sendResponse({ text: FR.buildL2Pack(await FR.exportAll()) }); break;
        }
        default: sendResponse({ ok: false, reason: 'unknown' });
      }
    } catch (e) {
      console.warn('[FR] msg error', msg && msg.type, e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // 异步响应
});

// SW 每次启动都恢复一次（覆盖浏览器未触发 onStartup 的情况）
restore();
