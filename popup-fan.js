// ===== 专注回收 Popup 扑克牌交互（外部文件，符合 MV3 内容安全策略 script-src 'self'）=====
// 交互（v1.3.2 起简化为一步）：鼠标悬停某张牌 → 该牌自动放大、浮到最上层、选项直接成为可点按键；
// 直接点击选项即弹出内容，无需先点击"摆正"。鼠标移开自动恢复扇形。
// 本文件必须在 body 末尾、popup.js 之后加载。
(function () {
  'use strict';

  function closePanel() {
    const p = document.getElementById('cardPanel');
    if (p) p.classList.remove('show');
  }

  function showPanel(title, content) {
    document.getElementById('panelTitle').textContent = title;
    document.getElementById('panelContent').innerHTML = content;
    document.getElementById('cardPanel').classList.add('show');
  }

  function txt(id) { const el = document.getElementById(id); return el ? el.textContent : '—'; }

  function row(a, b) {
    return '<div class="stat-row"><span>' + a + '</span><strong>' + b + '</strong></div>';
  }

  // 点击扑克牌上的文字按键 → 直接弹出对应内容（不依赖"已摆正"状态）
  function handleKeyAction(action) {
    switch (action) {
      case 'blocks': {
        showPanel('完成块数',
          row('今日完成', txt('kBlocks')) +
          row('说明', '每完成一个专注周期计 1 块'));
        break;
      }
      case 'rate': {
        showPanel('自评专注率',
          row('今日专注率', txt('kRate')) +
          row('计算方式', '专注块数 /（专注+走神）'));
        break;
      }
      case 'studytime': {
        showPanel('学习 / 娱乐时长',
          row('学习时长', txt('kStudy')) +
          row('娱乐时长', txt('kFun')) +
          row('说明', '自动识别网站类型统计'));
        break;
      }
      case 'weektrend':
      case 'todaycompare': {
        showPanel('本周专注趋势', '扑克牌区可切换查看完整 7 天柱状图，今日数据已高亮显示。');
        break;
      }
      case 'summary': {
        const btn = document.getElementById('btnSummary');
        if (btn) btn.click(); // 触发 popup.js 生成今日小结
        showPanel('今日小结', '正在生成小结，请稍候…');
        setTimeout(function () {
          const summaryText = (document.getElementById('summary') || {}).textContent;
          if (summaryText && summaryText.trim()) {
            showPanel('今日小结', summaryText.replace(/\n/g, '<br>'));
          }
        }, 500);
        break;
      }
      case 'copy': {
        const btn = document.getElementById('btnCopy');
        if (btn) btn.click();
        showPanel('复制复盘', '复盘包已复制到剪贴板，可直接粘贴给豆包做每日复盘分析。');
        break;
      }
      case 'settings': {
        try { chrome.runtime.openOptionsPage(); } catch (e) {}
        break;
      }
      case 'features': {
        showPanel('功能介绍',
          '<strong>🎯 定时自检</strong><br>到点弹出"是/否"自检，培养元认知<br><br>' +
          '<strong>🔄 走神回收</strong><br>走神后标记原因，快速回收注意力<br><br>' +
          '<strong>📊 网站统计</strong><br>自动识别学习 / 娱乐网站时长<br><br>' +
          '<strong>⏱️ 静止检测</strong><br>页面长时间静止提醒，防止人已离开还在计时');
        break;
      }
      case 'guide': {
        showPanel('操作指南',
          '1. 选择专注时长，点击"开始专注"<br>' +
          '2. 到点后在网页浮层完成"是/否"自检<br>' +
          '3. 走神了选择原因并回收注意力<br>' +
          '4. 鼠标移到扑克牌上，直接点击选项查看数据和工具<br>' +
          '5. 右键网页悬浮球可暂停 / 结束 / 设置');
        break;
      }
      case 'faq': {
        showPanel('常见问题',
          '<strong>Q：数据会上传吗？</strong><br>A：不会，所有数据纯本地存储，零联网、不截屏。<br><br>' +
          '<strong>Q：全屏看课时悬浮球看不到？</strong><br>A：到点有系统通知 + 提示音 + 标题闪烁三重兜底。<br><br>' +
          '<strong>Q：扩展更新后页面不刷新？</strong><br>A：点击"刷新所有页面"按钮一键刷新全部标签页。');
        break;
      }
    }
  }

  // 历史详情页导航（popup.js 不依赖，仅 detail-back 返回按钮使用）
  function showDetail(id) {
    const main = document.getElementById('mainView');
    if (main) main.style.display = 'none';
    document.querySelectorAll('.detail-view').forEach(d => d.classList.remove('active'));
    const target = document.getElementById(id);
    if (target) target.classList.add('active');
  }
  function backToMain() {
    document.querySelectorAll('.detail-view').forEach(d => d.classList.remove('active'));
    const main = document.getElementById('mainView');
    if (main) main.style.display = 'block';
  }

  // ===== 事件绑定（本文件在 body 末尾加载，DOM 已就绪）=====
  function init() {
    const fan = document.getElementById('fanCards');
    if (fan) {
      fan.addEventListener('click', function (e) {
        // 悬停后直接点击文字按键 → 弹出内容（无需先摆正）
        const key = e.target.closest('.key');
        if (key) {
          e.stopPropagation();
          handleKeyAction(key.dataset.action);
        }
        // 点击牌的其他区域不再做"摆正"，无操作
      });
    }
    const panelClose = document.querySelector('.panel-close');
    if (panelClose) panelClose.addEventListener('click', closePanel);
    document.querySelectorAll('.detail-back').forEach(b => b.addEventListener('click', backToMain));
  }

  init();

  window.__fan = { showPanel: showPanel, closePanel: closePanel, showDetail: showDetail };
})();
