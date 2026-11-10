/**
 * Nova 界面复刻与脚本化演示。
 *
 * 在 1280×800 的 DOM 里按真实浅色主题重建 Nova 的侧栏、对话流、输入区和右侧面板，
 * 模拟一次完整闭环：领航模式下只说目标 → 动态待办推进 → 内置浏览器真实验证 →
 * 证据卡与诚实交付 → 一键切到学习逐步讲解 → 出题考查 → 生成项目大纲。
 *
 * 时间全部经由 wait() 推进：它负责暂停、取消（runToken 变化即抛出 CANCEL）和章节进度计时；
 * 快进模式下 wait() 立即返回，用于跳章时把前面章节的状态瞬间重建出来。
 */

const CANCEL = Symbol('cancel');

const P = {
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
  folderOpen: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  panelLeft: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  panelRight: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  cornerDownRight: '<polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
  fileText: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  fileCode: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  userCheck: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  minus: '<path d="M5 12h14"/>',
  square: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
};

function ico(name, size = 16, width = 2) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${P[name]}</svg>`;
}

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

const PROMPT = '番茄钟刷新页面后又回到 25:00 了，帮我修好';
const ANSWER = '每秒 save() 把剩余秒数写进 localStorage，页面加载时先 getItem 读回来';
const QUESTION = '刷新页面后，倒计时为什么能接着上次的走？';

/* AssistantPendingIndicator 的轮换文案 */
const PENDING_LINES = [
  'Nova正在把思路焊起来...',
  '正在摸清这个仓库的脾气...',
  'Nova正在翻代码，马上回来...',
  '正在和Bug讲道理...',
  '认真干活中，一步一步来...',
  '代码在路上，Nova正在收尾...'
];

const PILOT_TODOS = [
  '复现：刷新页面，确认倒计时回到 25:00',
  '定位根因：存档写了，启动时有没有读回',
  '修复读取，不改写入逻辑',
  '在真实页面里验证刷新后接着走'
];

export const CHAPTERS = [
  { label: '领航接手', caption: '只说目标，领航自动匹配修复打法并列出动态待办，边排查边推进。', est: 9800 },
  { label: '真实验证', caption: '改完代码不算完，自动拉起右侧内置浏览器与检查脚本核验真实页面。', est: 9400 },
  { label: '证据交付', caption: '实时页面画面与验证日志收进交付卡，实测结果与未覆盖边界分开交代。', est: 9200 },
  { label: '学懂这次改动', caption: '点一下回复下方的书本图标切到学习，顺着源码数据流一步步拆解。', est: 15500 },
  { label: '考考你', caption: '围绕核心因果与取舍出题，确认你真吃透了再往下讲。', est: 15000 },
  { label: '项目大纲', caption: '自动扫描源码并核对出处，按用途、流程、数据与取舍生成学习地图。', est: 8200 }
];

export function createNovaSim(root) {
  let runToken = 0;
  let fast = false;
  let paused = false;
  let resumeWaiters = [];
  const timers = new Set();
  const listeners = { chapter: [], done: [] };
  let chapterElapsed = 0;
  let currentChapter = -1;
  let refs = null;

  /* ---------- 时间 ---------- */

  function sleep(ms) {
    return new Promise(resolve => {
      const id = setTimeout(() => { timers.delete(id); resolve(); }, ms);
      timers.add(id);
    });
  }

  async function wait(ms) {
    if (fast) return;
    const token = runToken;
    let left = ms;
    while (left > 0) {
      if (paused) await new Promise(resolve => resumeWaiters.push(resolve));
      if (token !== runToken) throw CANCEL;
      const step = Math.min(left, 40);
      await sleep(step);
      left -= step;
      chapterElapsed += step;
    }
    if (token !== runToken) throw CANCEL;
  }

  function clearTimers() {
    for (const id of timers) { clearTimeout(id); clearInterval(id); }
    timers.clear();
  }

  /* ---------- 骨架 ---------- */

  function build() {
    clearTimers();
    root.innerHTML = `
      <div class="nv-titlebar">
        <img class="nv-titlebar__logo" src="assets/nova-oracle.png" alt="">
        <span class="nv-titlebar__toggle">${ico('panelLeft', 17)}</span>
        <div class="nv-winctl"><span>${ico('minus', 15, 1.4)}</span><span>${ico('square', 14, 1.4)}</span><span>${ico('x', 15, 1.4)}</span></div>
      </div>
      <aside class="nv-side">
        <div class="nv-switch" data-ref="switch">
          <span class="nv-switch__thumb" data-ref="thumb"></span>
          <span class="nv-switch__btn nv-switch__btn--active" data-ref="btnDev">${ico('code', 14)}<span class="nv-switch__label">开发</span></span>
          <span class="nv-switch__btn" data-ref="btnLearn">${ico('book', 14)}<span class="nv-switch__label">学习</span></span>
        </div>
        <div class="nv-action">${ico('plus', 15)}<span>新会话</span><em>Ctrl+N</em></div>
        <div class="nv-action">${ico('folder', 15)}<span>添加工作区</span></div>
        <div class="nv-action">${ico('search', 15)}<span>搜索会话</span><em>Ctrl+P</em></div>
        <p class="nv-section">项目</p>
        <div class="nv-project">${ico('folderOpen', 16)}<span>tomato-timer</span></div>
        <div data-ref="sessions"></div>
        <span class="nv-side__foot">${ico('settings', 16)}</span>
      </aside>
      <section class="nv-main">
        <div class="nv-chat">
          <header class="nv-top">
            <span class="nv-top__crumb">${ico('folder', 16)}tomato-timer</span>
            <span class="nv-top__crumb">/</span>
            <span class="nv-top__title" data-ref="title">新会话</span>
            ${ico('chevronDown', 14)}
            <span class="nv-top__more">···</span>
            <div class="nv-top__right">
              <span class="nv-chip" data-ref="chip"></span>
              <span data-ref="panelBtn">${ico('panelRight', 17)}</span>
            </div>
          </header>
          <div class="nv-pop" data-ref="pop"></div>
          <div class="nv-scroll" data-ref="scroll"><div class="nv-flow" data-ref="flow"></div></div>
          <div class="nv-composer-wrap">
            <div class="nv-composer" data-ref="composer"></div>
            <div class="nv-ctxbar">${ico('folder', 14)}tomato-timer ${ico('chevronDown', 12)}</div>
          </div>
        </div>
        <aside class="nv-insp" data-ref="insp"><div class="nv-insp__inner" data-ref="inspInner"></div></aside>
      </section>
      <div class="nv-cursor" data-ref="cursor">
        <span class="nv-cursor__ring"></span>
        <svg width="22" height="22" viewBox="0 0 24 24"><path d="M5 3l14 8-6.2 1.6L9.6 19z" fill="#18181b" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>
      </div>`;
    refs = {};
    for (const node of root.querySelectorAll('[data-ref]')) refs[node.dataset.ref] = node;
    refs.cursorX = 900;
    refs.cursorY = 620;
    refs.cursor.style.transform = `translate(${refs.cursorX}px, ${refs.cursorY}px)`;
    setSurface('dev');
    setSessions([{ title: '新会话', active: true }]);
    setComposer('dev');
    placeThumb();
  }

  /* ---------- 局部视图 ---------- */

  function setSurface(surface) {
    refs.switch.dataset.surface = surface;
    refs.btnDev.classList.toggle('nv-switch__btn--active', surface === 'dev');
    refs.btnLearn.classList.toggle('nv-switch__btn--active', surface === 'learn');
    placeThumb();
  }

  function placeThumb() {
    const active = refs.switch.dataset.surface === 'learn' ? refs.btnLearn : refs.btnDev;
    refs.thumb.style.width = `${active.offsetWidth}px`;
    refs.thumb.style.transform = `translateX(${active.offsetLeft - 3}px)`;
  }

  function setSessions(list) {
    refs.sessions.innerHTML = list.length
      ? list.map(s => `<div class="nv-session${s.active ? ' nv-session--active' : ''}"><span>${s.title}</span><em>刚刚</em></div>`).join('')
      : '<p class="nv-empty-sessions">暂无会话</p>';
  }

  function setTitle(text) {
    refs.title.textContent = text;
    const active = refs.sessions.querySelector('.nv-session--active span');
    if (active) active.textContent = text;
  }

  function setChip(html, on = true) {
    refs.chip.innerHTML = html;
    refs.chip.classList.toggle('is-on', on);
  }

  /**
   * 输入区形态：dev / dev-running / learn / learn-running / dock（学习出题时替换输入区）。
   */
  function setComposer(mode) {
    const c = refs.composer;
    const running = mode.endsWith('running');
    const isPilot = mode.startsWith('dev');
    c.classList.toggle('nv-composer--pilot', isPilot);
    if (mode === 'dock') {
      c.innerHTML = `
        <p class="nv-dock__eyebrow">${ico('book', 13)}想一想</p>
        <p class="nv-dock__q">${QUESTION}</p>
        <div class="nv-composer__input" data-ref-local="input" data-placeholder="说说你的理解"></div>
        <div class="nv-dock__acts"><span>提示</span><span>直接讲</span><span>跳过</span><span class="nv-send-text" data-ref-local="send">提交</span></div>`;
    } else {
      const learn = mode.startsWith('learn');
      const placeholder = learn
        ? (running ? '回答中…' : '问任何关于这个项目的问题')
        : (running ? 'Agent 正在运行，输入将进入排队队列...' : '向 Nova 提问或分配编程任务...');
      const start = learn
        ? ''
        : `<span class="nv-ghost">${ico('plus', 17)}</span><span class="nv-pilot-pill">${ico('sun', 14)}领航 <i>×</i></span><span class="nv-ghost${running ? ' is-dim' : ''}" style="color:#8a4b00">${ico('shield', 15)}完全访问 ${ico('chevronDown', 14)}</span>`;
      c.innerHTML = `
        <div class="nv-composer__input" data-ref-local="input" data-placeholder="${placeholder}"></div>
        <div class="nv-composer__foot">${start}
          <div class="nv-composer__end">
            <span class="nv-ring"></span>
            <span class="nv-model">nova-demo-model ${ico('chevronDown', 14)}</span>
            <span class="nv-send${running ? ' is-stop' : ''}" data-ref-local="send">${running ? ico('stop', 13) : ico('send', 14, 2.5)}</span>
          </div>
        </div>`;
    }
    refs.input = c.querySelector('[data-ref-local="input"]');
    refs.send = c.querySelector('[data-ref-local="send"]');
  }

  /** 对话流贴底：内容超出可视区时整体上移，保留输入区遮挡的余量。 */
  function stick() {
    const overflow = refs.flow.scrollHeight - refs.scroll.clientHeight;
    refs.flow.style.transform = `translateY(${-Math.max(0, overflow)}px)`;
  }

  function append(node, before) {
    if (before) refs.flow.insertBefore(node, before); else refs.flow.appendChild(node);
    stick();
    return node;
  }

  function addUser(text) {
    return append(el('div', 'nv-user nv-fade', `<p>${text}</p>`));
  }

  function addPending() {
    const node = append(el('div', 'nv-pending nv-fade', `<span class="nv-orb"></span><span class="nv-pending__line">${PENDING_LINES[0]}</span>`));
    let index = 0;
    const line = node.querySelector('.nv-pending__line');
    const id = fast ? null : setInterval(() => {
      index = (index + 1) % PENDING_LINES.length;
      line.textContent = PENDING_LINES[index];
    }, 2300);
    if (id) timers.add(id);
    return {
      remove() {
        if (id) { clearInterval(id); timers.delete(id); }
        node.remove();
        stick();
      }
    };
  }

  /** 工具过程组：标题行汇总动作，下方按顺序列出每一步。 */
  function addProc() {
    const node = append(el('div', 'nv-proc nv-fade', `
      <div class="nv-proc__head"><span data-h></span>${ico('chevronDown', 13)}</div>
      <div data-slot></div>
      <div class="nv-proc__rows"></div>`));
    const head = node.querySelector('[data-h]');
    const rows = node.querySelector('.nv-proc__rows');
    const slot = node.querySelector('[data-slot]');
    return {
      node,
      head(html) { head.innerHTML = html; },
      row(icon, verb, target, opts = {}) {
        const r = el('div', 'nv-row', `
          <span class="${opts.iconClass ?? ''}">${ico(icon, 15)}</span>
          <span class="nv-row__verb">${verb}</span>
          <span class="nv-row__target${opts.cmd ? ' nv-row__target--cmd' : ''}">${target}</span>
          ${opts.state ? `<span class="nv-row__state">${opts.state}</span>${ico('chevronRight', 14)}` : ''}`);
        rows.appendChild(r);
        stick();
        return r;
      },
      slot,
      collapse(text) {
        node.className = 'nv-worked';
        node.innerHTML = `${text} ${ico('chevronRight', 13)}`;
        stick();
      }
    };
  }

  function addAssistant() {
    return append(el('div', 'nv-asst'));
  }

  /**
   * 流式写入：块为 { p | h | ul | node }，行内片段为字符串（普通文本）或 { code } / { b }。
   * 文本按 2 个字一跳推进，代码片段整段出现，贴近模型分片到达的观感。
   */
  async function stream(container, blocks) {
    for (const block of blocks) {
      if (block.node) {
        container.appendChild(block.node);
        stick();
        await wait(220);
        continue;
      }
      if (block.ul) {
        const ul = el('ul');
        container.appendChild(ul);
        for (const item of block.ul) {
          const li = el('li');
          ul.appendChild(li);
          await streamInline(li, item);
        }
        continue;
      }
      const node = el(block.h ? 'h4' : 'p');
      container.appendChild(node);
      await streamInline(node, block.h ? [block.h] : block.p);
    }
  }

  async function streamInline(node, parts) {
    for (const part of parts) {
      if (typeof part === 'object' && part.code) {
        node.appendChild(el('code', null, part.code));
        stick();
        await wait(60);
        continue;
      }
      const target = typeof part === 'object' && part.b ? node.appendChild(el('strong')) : node;
      const text = typeof part === 'object' ? part.b : part;
      const textNode = document.createTextNode('');
      target.appendChild(textNode);
      if (fast) { textNode.data = text; continue; }
      for (let i = 0; i < text.length; i += 2) {
        textNode.data = text.slice(0, i + 2);
        if (i % 12 === 0) stick();
        await wait(17);
      }
    }
    stick();
  }

  function addActions({ regenerate = true, learn = false } = {}) {
    const html = [
      regenerate ? `<span>${ico('refresh', 15)}</span>` : '',
      `<span>${ico('copy', 15)}</span>`,
      learn ? `<span data-learn>${ico('book', 15)}</span>` : ''
    ].join('');
    return append(el('div', 'nv-msg-actions nv-fade', html));
  }

  async function typeInto(node, text) {
    if (fast) { node.textContent = text; return; }
    const caret = el('span', 'nv-caret');
    node.textContent = '';
    const textNode = document.createTextNode('');
    node.append(textNode, caret);
    for (const ch of text) {
      textNode.data += ch;
      await wait(ch === '，' || ch === ' ' ? 140 : 46 + Math.random() * 40);
    }
    caret.remove();
  }

  /* ---------- 模拟光标 ---------- */

  function localPoint(target, fx = 0.5, fy = 0.5) {
    const box = root.getBoundingClientRect();
    const scale = box.width / 1280 || 1;
    const r = target.getBoundingClientRect();
    return {
      x: (r.left - box.left) / scale + (r.width / scale) * fx,
      y: (r.top - box.top) / scale + (r.height / scale) * fy
    };
  }

  async function point(target, fx, fy) {
    if (fast) return;
    const { x, y } = localPoint(target, fx, fy);
    refs.cursor.classList.add('is-on');
    refs.cursor.style.transform = `translate(${x - 4}px, ${y - 3}px)`;
    await wait(820);
  }

  async function click(target, fx, fy) {
    if (fast) return;
    await point(target, fx, fy);
    refs.cursor.classList.remove('is-click');
    void refs.cursor.offsetWidth;
    refs.cursor.classList.add('is-click');
    target.classList.add('is-pressed');
    await wait(170);
    target.classList.remove('is-pressed');
    await wait(160);
  }

  function hideCursor() { refs.cursor.classList.remove('is-on'); }

  /* ---------- 右侧面板与领航浮窗 ---------- */

  function setTodos(states, open = true) {
    const done = states.filter(s => s === 'done').length;
    const allDone = done === PILOT_TODOS.length;
    setChip(
      allDone
        ? `<span style="color:#16a34a;display:inline-flex">${ico('check', 13, 2.5)}</span><span style="color:#16a34a;font-weight:600">进程 ${done}/${PILOT_TODOS.length}</span>`
        : `<span class="nv-ring" style="width:12px;height:12px;border-color:#bbf7d0;border-top-color:#16a34a"></span><b>进程 ${done}/${PILOT_TODOS.length}</b>`,
      true
    );
    refs.pop.innerHTML = `
      <div class="nv-pop__head">${ico('check', 14, 2.5)}<span>进程 ${done}/${PILOT_TODOS.length}</span></div>
      <div class="nv-pop__sub"><span>进度</span><em>${done}/${PILOT_TODOS.length}</em></div>
      <ul class="nv-pop__list">
        ${PILOT_TODOS.map((text, i) => `
          <li class="nv-pop__item${states[i] === 'done' ? ' is-done' : states[i] === 'active' ? ' is-active' : ''}">
            <i>${states[i] === 'done' ? ico('check', 10, 3) : ''}</i><span>${text}</span>
          </li>`).join('')}
      </ul>
      ${done >= 2 ? `<div class="nv-pop__foot">${ico('code', 13)}<code>tomato-timer.html</code></div>` : ''}`;
    refs.pop.classList.toggle('is-open', open);
  }

  function closePop() {
    refs.pop.classList.remove('is-open');
  }

  function openBrowser() {
    refs.inspInner.innerHTML = `
      <div class="nv-insp__top"><span class="nv-tab">${ico('globe', 14)}内置浏览器</span>
        <span class="nv-insp__top-end">${ico('plus', 15)}${ico('panelRight', 16)}</span></div>
      <div class="nv-browser">
        <div class="nv-browser__bar">
          <span>←</span><span>→</span><span>↻</span>
          <div class="nv-browser__url">http://127.0.0.1:6020/</div>
          <span class="nv-btn" style="height:24px;font-size:12px;padding:0 8px">访问</span>
        </div>
        <div class="nv-browser__page">
          <div class="nv-pomo">
            <span class="nv-pomo__tag">🍅 专注进行中</span>
            <div class="nv-pomo__time" data-pomo-time>24:47</div>
            <div class="nv-pomo__done">今天已完成 <b>3</b> 个番茄</div>
            <div class="nv-pomo__bar"><i></i></div>
            <div class="nv-pomo__btns">
              <span class="nv-btn nv-btn--primary">继续专注</span>
              <span class="nv-btn nv-btn--ghost">重置</span>
            </div>
          </div>
        </div>
      </div>`;
    refs.insp.classList.add('is-open');
  }

  function openOutlineEmpty() {
    refs.inspInner.innerHTML = `
      <div class="nv-insp__top"><span class="nv-tab">${ico('fileText', 14)}大纲</span>
        <span class="nv-insp__top-end">${ico('plus', 15)}${ico('panelRight', 16)}</span></div>
      <div class="nv-outline" data-outline>
        <div class="nv-outline__build" data-build>
          <span>还没有大纲</span>
          <span class="nv-btn nv-btn--primary" data-gen>生成大纲</span>
          <span style="font-size:12.5px">读取部分代码，调用 1–2 次模型</span>
        </div>
      </div>`;
    refs.insp.classList.add('is-open');
  }

  function closeInspector() { refs.insp.classList.remove('is-open'); }

  /* ---------- 学习内联流程图 ---------- */

  const FLOW_STEPS = [
    ['点开始专注', '只起一个计时器'],
    ['每秒减一', 'setInterval 回调'],
    ['写进本机', 'save() 存进 localStorage'],
    ['刷新读回', '启动时 getItem']
  ];

  function flowViz() {
    const node = el('div', 'nv-flowviz', `
      <div class="nv-flowviz__steps">${FLOW_STEPS.map(([t], i) => `<div class="nv-flowviz__step${i === 0 ? ' is-on' : ''}"><i>${i + 1}</i>${t}</div>`).join('')}</div>
      <div class="nv-flowviz__detail"><div><b data-t>1. ${FLOW_STEPS[0][0]}</b><span data-d>${FLOW_STEPS[0][1]}</span></div>
        <div class="nv-flowviz__nav"><span class="nv-btn is-disabled" data-prev>上一步</span><span class="nv-btn nv-btn--primary" data-next>下一步</span></div></div>`);
    return node;
  }

  function setFlowStep(node, index) {
    node.querySelectorAll('.nv-flowviz__step').forEach((s, i) => s.classList.toggle('is-on', i === index));
    node.querySelector('[data-t]').textContent = `${index + 1}. ${FLOW_STEPS[index][0]}`;
    node.querySelector('[data-d]').textContent = FLOW_STEPS[index][1];
    node.querySelector('[data-prev]').classList.toggle('is-disabled', index === 0);
  }

  function addSuggestions(list) {
    return append(el('div', 'nv-suggest', list.map(t => `<p>${ico('cornerDownRight', 14)}<span>${t}</span></p>`).join('')));
  }

  /* ---------- 章节脚本 ---------- */

  const state = {};

  const chapters = [
    // 01 领航接手：只说目标，自动匹配修复方法并拉起动态待办
    async () => {
      await wait(450);
      await click(refs.input, 0.14, 0.5);
      await typeInto(refs.input, PROMPT);
      refs.send.classList.add('is-ready');
      await wait(240);
      await click(refs.send);
      hideCursor();
      refs.input.textContent = '';
      addUser(PROMPT);
      setComposer('dev-running');
      setTitle(PROMPT);
      let pending = addPending();
      await wait(1100);
      pending.remove();
      const proc = addProc();
      state.proc = proc;
      proc.head('调用技能 1 次，读取 1 个文件');
      proc.row('fileText', '读取', 'tomato-timer.html');
      setTodos(['done', 'active', 'pending', 'pending'], true);
      pending = addPending();
      await wait(1100);
      setTodos(['done', 'done', 'active', 'pending'], true);
      proc.head('调用技能 1 次，读取 2 个文件，写入 1 个文件');
      proc.row('fileCode', '写入', 'tomato-timer.html', { iconClass: 'nv-row__icon--html' });
      await wait(1200);
      state.pending = pending;
    },

    // 02 真实验证：拉起内置浏览器与检查脚本核验真实页面
    async () => {
      const proc = state.proc;
      state.pending?.remove();
      setTodos(['done', 'done', 'done', 'active'], true);
      proc.head('调用技能 1 次，读取 2 个文件，写入 1 个文件，浏览器验证中');
      proc.row('globe', '验证', 'http://127.0.0.1:6020/ 刷新读回存档');
      await wait(650);
      closePop();
      openBrowser();
      stick();
      await wait(1400);
      proc.row('terminal', '执行', 'RELOAD CHECK: 1200/1200 restored', { cmd: true });
      setTodos(['done', 'done', 'done', 'done'], false);
      const ev = append(el('div', 'nv-ev nv-fade', `
        <div class="nv-ev__head"><b>工具产物</b><span>仅表示产物存在，不代表目标已验证</span></div>
        <div class="nv-ev__label">修复后的页面画面 <em>来自 browser_capture</em></div>
        <div class="nv-ev__preview">
          <div class="nv-ev__timer">24:47</div>
          <div class="nv-ev__meta">今天已完成 <b>3</b> 个番茄</div>
          <span class="nv-ev__pill">专注进行中</span>
        </div>
        <span class="nv-btn" data-open-live>打开实时结果</span>
        <div class="nv-ev__sec">
          <div class="nv-ev__label">刷新后读回存档的逐次检查输出 <em>来自 bash</em></div>
          <span class="nv-btn" data-toggle-log>查看日志</span>
          <div class="nv-ev__log" data-log>
            [tick 0010] left=1490 saved=1490 after-reload=1490 ok<br>
            [tick 0011] left=1489 saved=1489 after-reload=1489 ok<br>
            [tick 0012] left=1488 saved=1488 after-reload=1488 ok<br>
            [tick 0013] left=1487 saved=1487 after-reload=1487 ok<br>
            <em>RELOAD CHECK: 1200/1200 restored</em>
          </div>
        </div>`));
      state.ev = ev;
      await wait(1600);
    },

    // 03 证据交付：展开验证日志，输出根因、验证方式与未验证边界
    async () => {
      closeInspector();
      await wait(550);
      const logBtn = state.ev.querySelector('[data-toggle-log]');
      const logBox = state.ev.querySelector('[data-log]');
      await click(logBtn);
      hideCursor();
      logBtn.textContent = '收起日志';
      logBox.classList.add('is-open');
      stick();
      await wait(900);
      state.proc.collapse('已工作 4 秒');
      const reply = addAssistant();
      await stream(reply, [
        { p: ['修好了：刷新页面后倒计时会接着上次的剩余时间走。'] },
        { p: [{ b: '根因：' }, '每秒都把剩余秒数写进了存档，但页面启动时 ', { code: 'left' }, ' 直接取了 25 分钟，从没读回存档。现在启动时先读存档，写入逻辑没动。'] },
        { p: [{ b: '验证：' }, '用同一个页面入口反复刷新，剩余秒数与存档逐次一致，输出和页面截图在上方。'] },
        { p: [{ b: '没验证的：' }, '跨天自动清零、多个标签页同时打开。'] }
      ]);
      state.actions = addActions({ learn: true });
      setComposer('dev');
      await wait(1300);
    },

    // 04 学懂这次改动
    async () => {
      closeInspector();
      closePop();
      await wait(650);
      const learnBtn = state.actions.querySelector('[data-learn]');
      await point(learnBtn);
      const tip = el('span', 'nv-tooltip', '学懂这次改动');
      learnBtn.appendChild(tip);
      await wait(900);
      await click(learnBtn);
      tip.remove();
      hideCursor();
      setSurface('learn');
      setSessions([{ title: '新会话', active: true }]);
      setTitle('新会话');
      setChip('', false);
      refs.flow.innerHTML = '';
      stick();
      const ask = `帮我搞懂「${PROMPT}」里的这次改动`;
      addUser(ask);
      setComposer('learn-running');
      const pending = addPending();
      await wait(1300);
      pending.remove();
      append(el('div', 'nv-worked nv-fade', `已工作 2 秒 ${ico('chevronRight', 13)}`));
      const reply = addAssistant();
      state.flowViz = flowViz();
      await stream(reply, [
        { p: ['我们一步一步来，这次只看', { b: '数据怎么流动' }, '，先不管样式。'] },
        { h: '第 1 步：计时从哪开始' },
        { p: ['你点「开始专注」时，', { code: 'start.onclick' }, ' 先看 ', { code: 'ticking' }, '：已经有计时器就直接返回，所以连点也只跑一个。'] },
        { node: state.flowViz },
        { p: ['接下来是 ', { code: 'save()' }, '：每过一秒，它把剩余秒数和今天的日期一起写进浏览器本地存储。'] }
      ]);
      addActions({ regenerate: false });
      state.suggest = addSuggestions(['为什么要先判断 ticking？', '跨天清零是怎么做到的？', '考考我']);
      setComposer('learn');
      await wait(900);
      const next = state.flowViz.querySelector('[data-next]');
      for (let i = 1; i < 3; i++) {
        await click(next);
        setFlowStep(state.flowViz, i);
        await wait(800);
      }
      hideCursor();
      await wait(700);
    },

    // 考考你
    async () => {
      const quiz = [...state.suggest.querySelectorAll('p')].at(-1);
      await click(quiz, 0.08, 0.5);
      hideCursor();
      state.suggest.remove();
      addUser('考考我');
      setComposer('learn-running');
      let pending = addPending();
      await wait(1100);
      pending.remove();
      const ask = addAssistant();
      await stream(ask, [{ p: ['好，来检查一下理解。'] }]);
      const askActions = addActions({ regenerate: false });
      setComposer('dock');
      await wait(900);
      await click(refs.input, 0.1, 0.5);
      await typeInto(refs.input, ANSWER);
      refs.send.classList.add('is-ready');
      await wait(300);
      await click(refs.send);
      hideCursor();
      setComposer('learn-running');
      const qrow = el('div', 'nv-qrow', `<span class="nv-ring"></span><span>${QUESTION}</span><span style="color:var(--text-muted);font-size:12.5px">评估中</span>`);
      append(qrow, askActions.nextSibling);
      addUser(ANSWER);
      pending = addPending();
      await wait(1500);
      qrow.innerHTML = `${ico('check', 15, 2.5)}<span>${QUESTION}</span>`;
      pending.remove();
      const reply = addAssistant();
      await stream(reply, [
        { p: ['对，关键就两处：', { code: 'save()' }, ' 每秒写一次，脚本开头 ', { code: 'getItem' }, ' 读回来。'] },
        { h: '第 2 步：跨天为什么会清零' },
        { p: ['存进去的不只是秒数，还有 ', { code: 'day' }, '。读回时比较 ', { code: 'saved.day === today()' }, '，不是今天就把 ', { code: 'done' }, ' 归零。'] }
      ]);
      addActions({ regenerate: false });
      addSuggestions(['如果用户改了系统时间会怎样？', '把这段改成按周统计']);
      setComposer('learn');
      await wait(1400);
    },

    // 项目大纲
    async () => {
      await click(refs.panelBtn);
      hideCursor();
      openOutlineEmpty();
      stick();
      await wait(900);
      const gen = refs.inspInner.querySelector('[data-gen]');
      await click(gen);
      hideCursor();
      const build = refs.inspInner.querySelector('[data-build]');
      build.innerHTML = `<span class="nv-ring"></span><div class="nv-outline__stages"><span>扫描代码</span><span>整理大纲</span><span>核对出处</span></div>`;
      const stages = build.querySelectorAll('.nv-outline__stages span');
      for (let i = 0; i < stages.length; i++) {
        stages.forEach((s, j) => { s.classList.toggle('is-on', j === i); s.classList.toggle('is-done', j < i); });
        await wait(850);
      }
      const outline = refs.inspInner.querySelector('[data-outline]');
      outline.innerHTML = '<p class="nv-outline__menu">···</p>';
      const groups = [
        ['项目用途', '这个页面解决什么问题'],
        ['启动与运行', '打开页面时发生了什么'],
        ['关键用户流程', '计时如何开始与停止'],
        ['数据与状态', '数据存在哪、怎么读回'],
        ['设计与取舍', '为什么不用后端']
      ];
      for (const [group, topic] of groups) {
        outline.appendChild(el('div', 'nv-og', `<h5>${group}</h5><p>${topic}<em>≈</em></p>`));
        await wait(260);
      }
      await wait(2600);
    }
  ];

  /* ---------- 播放控制 ---------- */

  function emit(type, value) { for (const fn of listeners[type]) fn(value); }

  async function runChapter(index) {
    currentChapter = index;
    chapterElapsed = 0;
    emit('chapter', index);
    await chapters[index]();
    emit('done', index);
  }

  /** 快进到 index 之前的状态（不产生动画），返回后可从 index 正常播放。 */
  async function fastForward(index) {
    fast = true;
    root.classList.add('is-instant');
    build();
    Object.keys(state).forEach(k => delete state[k]);
    try {
      for (let i = 0; i < index; i++) await chapters[i]();
    } finally {
      fast = false;
      hideCursor();
      // 让瞬时状态先落一帧，再恢复过渡
      requestAnimationFrame(() => root.classList.remove('is-instant'));
    }
  }

  async function play(from = 0, { loop = true } = {}) {
    const token = ++runToken;
    clearTimers();
    resumeWaiters.splice(0).forEach(fn => fn());
    try {
      await fastForward(from);
      if (token !== runToken) return;
      for (let i = from; i < chapters.length; i++) await runChapter(i);
      if (!loop) return;
      await wait(2500);
      if (token === runToken) play(0);
    } catch (error) {
      if (error !== CANCEL) throw error;
    }
  }

  /** 静止展示某一章的终态，用于减弱动态。 */
  async function show(index) {
    ++runToken;
    clearTimers();
    await fastForward(index + 1);
    currentChapter = index;
    emit('chapter', index);
    emit('done', index);
  }

  build();

  return {
    play,
    show,
    pause() { paused = true; },
    resume() {
      paused = false;
      resumeWaiters.splice(0).forEach(fn => fn());
    },
    stop() { ++runToken; clearTimers(); },
    get chapter() { return currentChapter; },
    progress() {
      const c = CHAPTERS[currentChapter];
      return c ? Math.min(0.98, chapterElapsed / c.est) : 0;
    },
    on(type, fn) { listeners[type].push(fn); }
  };
}
