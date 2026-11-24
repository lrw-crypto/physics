import { syncOrigin } from './config.js';

const app = document.querySelector('#app');
const nav = document.querySelector('#nav');
const letters = 'ABCDE';
const types = { c: '單選題', f: '填充題', w: '非選題' };
const sources = {
  doc: '補充試題', book: '教師本第 1 章', guide: '教師本導覽',
  past: '歷屆試題', quiz: '補充測驗卷'
};
const publisherSources = {
  example: '範例練習', exercise: '課後習題', past: sources.past, quiz: sources.quiz, doc: sources.doc
};
const escaped = value => String(value ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const read = (key, fallback, area = localStorage) => {
  try { return JSON.parse(area.getItem('physics:' + key)) ?? fallback; }
  catch { return fallback; }
};
const store = (key, value, area = localStorage) => {
  try { area.setItem('physics:' + key, JSON.stringify(value)); return true; }
  catch { return false; }
};
const state = {
  bank: [], archivedQuestions: [], chapters: [], selected: new Set(), wrongSelected: new Set(),
  questionAliases: new Map(), publisherChapters: {}, textbookTopics: {},
  chapter: '1', source: '', type: '', order: 'original', count: 'all', wrongChapter: '',
  account: read('account', null, sessionStorage), loginMode: 'login',
  records: {}, run: null, status: '', sync: null
};
const recordsKey = name => 'records:' + name;
const pendingKey = name => 'pending:' + name;
const pending = name => read(pendingKey(name), []);
const current = () => location.hash.slice(1) || 'units';
const bySection = id => state.chapters.flatMap(c => c.sections).find(s => s.id === id);
const sectionLabel = id => id + ' ' + bySection(id)?.name;
const textbookFile = chapter => `assets/textbook/chapter-${chapter}.pdf`;
const wrong = () => [...state.bank, ...state.archivedQuestions].filter(q => (state.records[q.id]?.wrong || 0) > 0);
const recordCount = () => Object.values(state.records).reduce((totals, item) =>
  ({ right: totals.right + item.correct, wrong: totals.wrong + item.wrong }), { right: 0, wrong: 0 });
const humanError = error => ({
  bad_login: '帳號或密碼有誤。', name_taken: '這個代稱已被使用，請換一個代稱。',
  invalid_credentials: '代稱需為 3–24 個字元，可使用中英文、數字、點號、底線及連字號。密碼至少 8 個字元。',
  rate_limit: '短時間內嘗試次數較多，請稍後再試。',
  unauthorized: '登入已過期，請再登入一次。'
})[error?.message] || '暫時連不上帳號服務，請稍後再試。';

async function api(path, { body, token } = {}) {
  const response = await fetch(syncOrigin + path, {
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'server_unavailable');
  return data;
}
function tally(records, attempt) {
  const key = state.questionAliases.get(attempt.questionId) ?? attempt.questionId;
  const entry = records[key] || { correct: 0, wrong: 0 };
  entry[attempt.correct ? 'correct' : 'wrong'] += 1;
  entry.updated = Math.floor(Date.now() / 1000);
  records[key] = entry;
}
function loadLocal() {
  const name = state.account?.name || '@guest';
  const records = Object.create(null);
  for (const [questionId, entry] of Object.entries(read(recordsKey(name), {}))) {
    const key = state.questionAliases.get(questionId) ?? questionId;
    const existing = records[key] ?? { correct: 0, wrong: 0, updated: 0 };
    records[key] = {
      correct: existing.correct + entry.correct,
      wrong: existing.wrong + entry.wrong,
      updated: Math.max(existing.updated, entry.updated ?? 0)
    };
  }
  state.records = records;
  if (state.account) pending(name).forEach(a => tally(state.records, a));
}
function syncBadge(message) {
  state.status = message;
  updateNav();
  const slot = app.querySelector('#sync-status');
  if (slot) slot.textContent = message;
}
async function sync() {
  const account = state.account;
  if (!account) return;
  if (state.sync) return state.sync;
  const { token, name } = account;
  syncBadge('同步中…');
  const task = (async () => {
    try {
      // Keep acknowledged IDs until the corresponding server totals arrive.
      const acknowledged = new Set();
      while (true) {
        const batch = pending(name).filter(a => !acknowledged.has(a.id)).slice(0, 50);
        if (!batch.length) break;
        await api('/attempts', { token, body: { attempts: batch } });
        batch.forEach(a => acknowledged.add(a.id));
      }
      const response = await api('/records', { token });
      if (state.account !== account) return;
      const records = Object.fromEntries(response.records.map(a => [a.questionId, a]));
      const remaining = pending(name).filter(a => !acknowledged.has(a.id));
      store(recordsKey(name), records);
      store(pendingKey(name), remaining);
      loadLocal();
      syncBadge(remaining.length ? '待同步' : '已同步');
      if (['wrong', 'account'].includes(current())) render(false);
    } catch (error) {
      if (state.account !== account) return;
      syncBadge(error.message === 'unauthorized' ? '請重新登入以同步' : '同步暫停，將再試一次');
    } finally {
      if (state.account === account) {
        state.sync = null;
        if (state.status === '待同步') void sync();
      }
    }
  })();
  state.sync = task;
  return task;
}
function remember(q, correct) {
  const attempt = { id: crypto.randomUUID(), questionId: q.id, correct };
  tally(state.records, attempt);
  if (state.account) {
    const key = pendingKey(state.account.name);
    const saved = store(key, [...pending(state.account.name), attempt]);
    if (saved) void sync();
    else syncBadge('瀏覽器無法儲存這次紀錄');
  } else {
    store(recordsKey('@guest'), state.records);
  }
  updateNav();
}
function go(where) {
  if (current() === where) render(true);
  else location.hash = where;
}
function draw(html, focus) {
  app.innerHTML = html;
  if (focus) {
    window.scrollTo(0, 0);
    (app.querySelector('h1') || app).focus({ preventScroll: true });
  }
}
function heading(value, cls = 'page-title') {
  return `<h1 class="${cls}" tabindex="-1">${escaped(value)}</h1>`;
}
function updateNav() {
  const page = current();
  const links = [
    ['units', '單元練習', page === 'units' || page === 'practice' || page === 'result'],
    ['wrong', `錯題本 ${wrong().length}`, page === 'wrong'],
    ['account', state.account ? state.account.name : '登入／註冊', page === 'account']
  ];
  nav.innerHTML = links.map(([id, label, active]) =>
    `<a class="nav ${active ? 'active' : ''} ${id === 'account' ? 'account' : ''}" href="#${id}" ${active ? 'aria-current="page"' : ''}>${escaped(label)}</a>`).join('');
}
function math(source) {
  if (!window.katex) return escaped(source);
  try { return window.katex.renderToString(source, { output: 'mathml', strict: 'ignore', throwOnError: true }); }
  catch { return escaped(source); }
}
function bookRef(chunk) {
  const [, id, first, last] = chunk.match(/^\{\{book:(\d+):(\d+)(?:-(\d+))?\}\}$/);
  const chapter = state.chapters.find(c => c.id === id);
  const label = last ? `課本第 ${first}–${last} 頁` : `課本第 ${first} 頁`;
  if (!Number.isInteger(chapter?.textbookOffset)) return escaped(label);
  const href = `${textbookFile(id)}#page=${Number(first) + chapter.textbookOffset}`;
  return `<a class="book-ref" href="${escaped(href)}" target="_blank" rel="noopener">${escaped(label)}</a>`;
}
function rich(value) {
  return String(value ?? '').split(/(⟪[\s\S]*?⟫|\{\{(?:img:[^{}]+|blank:\d+|book:\d+:\d+(?:-\d+)?)\}\}|⟦[_^!][^⟧]+⟧)/g).map(chunk => {
    if (chunk.startsWith('⟪')) return math(chunk.slice(1, -1));
    if (chunk.startsWith('{{book:')) return bookRef(chunk);
    if (chunk.startsWith('{{img:')) {
      const img = chunk.slice(6, -2);
      return `<img class="figure" src="assets/figures/${escaped(img)}" alt="題目或解析所用圖示" decoding="async">`;
    }
    if (chunk.startsWith('{{blank:')) {
      return `<span class="blank" aria-label="第 ${escaped(chunk.slice(8, -2))} 格">(${escaped(chunk.slice(8, -2))})</span>`;
    }
    if (chunk.startsWith('⟦')) {
      const tag = { '^': 'sup', '_': 'sub', '!': 'strong' }[chunk[1]];
      return `<${tag}>${escaped(chunk.slice(2, -1))}</${tag}>`;
    }
    return escaped(chunk);
  }).join('');
}
// Worked solutions are plain text with three block forms: 【heading】 lines,
// pipe tables (| a | b |, second row |---|---|), and ordinary text lines.
function tableCells(line) {
  let body = line.trim().slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  const cells = [];
  let cell = '';
  let inMath = false;
  for (const ch of body) {
    if (ch === '⟪') inMath = true;
    if (ch === '⟫') inMath = false;
    if (ch === '|' && !inMath) { cells.push(cell.trim()); cell = ''; }
    else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}
const ruleRow = cells => cells.every(cell => /^:?-{2,}:?$/.test(cell));
function solutionBlocks(value) {
  const blocks = [];
  for (const line of String(value ?? '').split('\n')) {
    const kind = /^\s*\|/.test(line) ? 'table' : /^【[^】]+】$/.test(line.trim()) ? 'head' : 'text';
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind && kind !== 'head') last.lines.push(line);
    else blocks.push({ kind, lines: [line] });
  }
  return blocks.map(block => {
    if (block.kind === 'table') {
      const [head = [], ...body] = block.lines.map(tableCells).filter(cells => !ruleRow(cells));
      return { kind: 'table', head, body };
    }
    if (block.kind === 'head') return { kind: 'head', text: block.lines[0].trim() };
    return { kind: 'text', text: block.lines.join('\n').replace(/^\s*\n|\n\s*$/g, '') };
  }).filter(block => block.kind !== 'text' || block.text.trim());
}
const verdictClass = cell => cell.startsWith('○') ? ' class="ok"' : cell.startsWith('×') ? ' class="ng"' : '';
function richSolution(value) {
  return solutionBlocks(value).map(block => {
    if (block.kind === 'head') return `<div class="sol-head">${escaped(block.text)}</div>`;
    if (block.kind === 'text') return `<div class="sol-text">${rich(block.text)}</div>`;
    const row = cells => cells.map(cell => `<td${verdictClass(cell)}>${rich(cell)}</td>`).join('');
    return `<div class="table-wrap"><table class="sol-table"><thead><tr>${block.head.map(cell => `<th>${rich(cell)}</th>`).join('')}</tr></thead>` +
      `<tbody>${block.body.map(cells => `<tr${cells.some(cell => cell.includes('（答案）')) ? ' class="answer-row"' : ''}>${row(cells)}</tr>`).join('')}</tbody></table></div>`;
  }).join('');
}
function matchesSource(question, source) {
  if (!source || source === question.source) return true;
  const category = source === 'doc' ? 'supplement' : source;
  return (question.publisherRefs ?? []).some(reference => reference.category === category);
}
function sourceLabel(question) {
  if (question.source === 'quiz') return `補充測驗卷第 ${question.unit.split('-')[0]} 回`;
  const category = question.publisherRefs?.[0]?.category;
  return publisherSources[category] ?? sources[question.source];
}
function availableSources(chapter) {
  const prefix = chapter + '-';
  const labels = state.publisherChapters[chapter] ? publisherSources : sources;
  const available = {};
  for (const [key, label] of Object.entries(labels)) {
    if (state.bank.some(q => matchesSource(q, key) && q.unit.startsWith(prefix))) {
      available[key] = key === 'quiz' ? `補充測驗卷第 ${chapter} 回` : label;
    }
  }
  return available;
}
function filterQuestions() {
  return state.bank.filter(q => state.selected.has(q.unit) &&
    matchesSource(q, state.source) && (!state.type || state.type === q.type));
}
function radioStyle(active) { return active ? 'active' : ''; }
function unitsView(focus) {
  const chapter = state.chapters.find(c => c.id === state.chapter);
  const chapterQs = state.bank.filter(q => q.unit.startsWith(chapter.id + '-'));
  const publisher = state.publisherChapters[chapter.id];
  const option = (value, label, active) => `<option value="${value}" ${active === value ? 'selected' : ''}>${escaped(label)}</option>`;
  draw(`<section class="hero">
    <div class="hero-label">技高物理 B 上</div>
    ${heading('物理刷題站', '')}
    <p>按節練習，作答即看詳解。把做錯的題目挑出來，整理成可列印的錯題本。</p>
    <div class="stats"><span><strong>${state.chapters.length}</strong>章</span><span><strong>${state.chapters.flatMap(c => c.sections).length}</strong>節</span><span><strong>${state.bank.length}</strong>題</span></div>
  </section>
  <div class="workspace">
    <aside class="panel sidebar" aria-label="課本章節">
      <h2>課本章節</h2>
      ${state.chapters.map(c => `<button type="button" data-chapter="${c.id}" class="chapter ${radioStyle(c.id === chapter.id)}" aria-pressed="${c.id === chapter.id}"><small>${c.id.padStart(2, '0')}</small><span>${escaped(c.name)}</span><span class="count">${state.bank.filter(q => q.unit.startsWith(c.id + '-')).length}</span></button>`).join('')}
    </aside>
    <section class="panel" aria-labelledby="chapter-title">
      <label class="field mobile-chapter">課本章節<select id="mobile-chapter">${state.chapters.map(c => option(c.id, `第 ${c.id} 章　${c.name}`, chapter.id)).join('')}</select></label>
      <div class="section-head"><div><div class="tag">第 ${chapter.id} 章</div><h2 id="chapter-title">${escaped(chapter.name)}</h2>
        ${publisher?.exact ? `<p class="count-line">${escaped(publisher.name)} 原題 ${publisher.references} 題</p>` : ''}
        ${Number.isInteger(chapter.textbookOffset) ? `<a class="textbook-link" href="${textbookFile(chapter.id)}" target="_blank" rel="noopener">開啟本章課本 PDF</a>` : ''}</div>
      <button type="button" class="btn" data-action="toggle-sections">${chapter.sections.every(s => state.selected.has(s.id)) ? '取消全選' : '全選本章'}</button></div>
      <div class="subrows">${chapter.sections.map(s => `<label class="subrow"><input type="checkbox" name="section" value="${s.id}" ${state.selected.has(s.id) ? 'checked' : ''}><span><strong>${s.id}</strong>　${escaped(s.name)}</span><span class="meta">${chapterQs.filter(q => q.unit === s.id).length} 題</span></label>`).join('')}</div>
      <div class="filter-grid">
        <label class="field">來源<select name="source">${option('', '全部來源', state.source)}${Object.entries(availableSources(chapter.id)).map(([k, v]) => option(k, v, state.source)).join('')}</select></label>
        <label class="field">題型<select name="type">${option('', '全部題型', state.type)}${Object.entries(types).map(([k, v]) => option(k, v, state.type)).join('')}</select></label>
        <label class="field">題數<select name="count">${[['all', '全部題目'], ['10', '10 題'], ['20', '20 題'], ['30', '30 題']].map(([k, v]) => option(k, v, state.count)).join('')}</select></label>
      </div>
      <div class="actions">
        <button type="button" class="btn primary" data-action="start" ${filterQuestions().length ? '' : 'disabled'}>開始練習</button>
        <label class="subrow"><input type="checkbox" name="shuffle" ${state.order === 'random' ? 'checked' : ''}> 隨機順序</label>
        <span class="count-line" id="unit-count">可練習 ${filterQuestions().length} 題</span>
      </div>
    </section>
  </div>`, focus);
}
function setChapter(id) {
  state.chapter = id;
  if (state.source && !Object.hasOwn(availableSources(id), state.source)) state.source = '';
  state.selected = new Set(state.chapters.find(c => c.id === id).sections.map(s => s.id));
  unitsView(false);
}
function refreshUnitControls() {
  const count = filterQuestions().length;
  app.querySelector('[data-action="start"]').disabled = !count;
  app.querySelector('#unit-count').textContent = '可練習 ' + count + ' 題';
  app.querySelector('[data-action="toggle-sections"]').textContent =
    [...app.querySelectorAll('[name="section"]')].every(n => n.checked) ? '取消全選' : '全選本章';
}
function shuffled(values) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}
function start(questions, isWrong = false) {
  if (!questions.length) return;
  let items = questions;
  if (!isWrong && (state.order === 'random' || state.count !== 'all')) items = shuffled(items);
  if (!isWrong && state.count !== 'all') items = items.slice(0, Number(state.count));
  const responses = items.map(() => ({ draft: null, submission: null }));
  state.run = { items, responses, isWrong, index: 0 };
  go('practice');
}
function context(q) {
  return q.context ? `<div class="context">${rich(q.context)}</div>` : '';
}
function optionsHTML(q, { submission, draft, staticOnly = false } = {}) {
  return q.options.map((value, index) => {
    const letter = letters[index];
    if (staticOnly) return `<div><strong>(${letter})</strong> ${rich(value)}</div>`;
    const cls = submission && letter === q.answer ? 'right' :
      submission && submission.value === letter ? 'miss' : '';
    return `<label class="option ${cls}"><input type="radio" name="option" value="${letter}" ${(submission?.value ?? draft) === letter ? 'checked' : ''} ${submission ? 'disabled' : 'required'}><span class="letter">${letter}</span><span>${rich(value)}</span></label>`;
  }).join('');
}
function answerHTML(q) {
  if (q.type === 'c') return `<strong>${escaped(q.answer)}</strong> ${rich(q.options[letters.indexOf(q.answer)])}`;
  if (q.type === 'f') return q.answer.map((a, i) => `(${i + 1}) ${rich(a)}`).join('　');
  return rich(q.answer || '見下方詳解。');
}
function textbookGuide(q) {
  const topic = state.textbookTopics[q.textbook?.topic];
  if (!topic) return null;
  const makeLink = (unit, [first, last = first], label) => {
    const chapter = state.chapters.find(c => unit.startsWith(c.id + '-'));
    const filePage = first + chapter.textbookOffset;
    const printedPages = first === last ? first : `${first}–${last}`;
    const filePages = first === last ? filePage : `${filePage}–${last + chapter.textbookOffset}`;
    return {
      href: `${textbookFile(chapter.id)}#page=${filePage}`,
      text: `${label}｜課本第 ${printedPages} 頁（PDF 第 ${filePages} 頁）`
    };
  };
  const links = topic.pages.map(pages => makeLink(topic.unit, pages, topic.title));
  if (q.textbook.exercisePage) links.unshift(makeLink(q.unit, [q.textbook.exercisePage], '課本同題'));
  return { explanation: topic.explanation, links };
}
function solution(q, submission) {
  const label = q.type === 'w' ? '參考答案與解析' : '答案與解析';
  const result = submission?.correct === true ? '・答對了' :
    submission?.correct === false ? (q.type === 'w' ? '・待複習' : '・再想一想') : '';
  const guide = textbookGuide(q);
  return `<section class="feedback ${submission && submission.correct === false ? 'wrong' : ''}">
    <h3>${label}${result}</h3>
    ${q.type !== 'w' || q.answer ? `<div><strong>答案</strong>　${answerHTML(q)}</div>` : ''}
    <h4>詳解</h4>
    <div class="explain solution">${richSolution(q.workedExplanation ?? q.explanation)}</div>
    ${guide ? `<div class="textbook-guide"><h4>解題觀念與課本頁碼</h4>
    <p class="explain">${rich(guide.explanation)}</p>
    <ul class="textbook-refs">${guide.links.map(link => `<li><a class="textbook-link" href="${escaped(link.href)}" target="_blank" rel="noopener">${escaped(link.text)}</a></li>`).join('')}</ul></div>` : ''}
  </section>`;
}
function entry(q, { submission, draft }) {
  const answer = submission?.value ?? draft;
  if (q.type === 'c') return `<fieldset class="options" style="border:0;padding:0;margin:0"><legend class="sr">選擇一個答案</legend>${optionsHTML(q, { submission, draft })}</fieldset>`;
  if (q.type === 'w') return `<label class="field">你的答案<textarea name="written" rows="4" maxlength="1000" ${submission ? 'readonly' : ''} placeholder="寫下答案或解題步驟">${escaped(answer ?? '')}</textarea></label>`;
  return `<div class="entry-grid">${q.answer.map((_, i) =>
    `<label class="field">第 ${i + 1} 格<input name="blank" value="${escaped(answer?.[i] ?? '')}" ${submission ? 'readonly' : 'required'} maxlength="128" autocomplete="off"></label>`).join('')}</div>${submission ? '' : '<p class="meta">依題目所列單位填答，可用 1/2、10^3、pi 或 sqrt(2) 輸入數學符號。</p>'}`;
}
function practiceView(focus) {
  if (!state.run) return unitsView(focus);
  const { items, index, responses } = state.run;
  const q = items[index];
  const response = responses[index];
  const { submission } = response;
  const needsReview = q.type === 'w' && submission?.correct === null;
  draw(`<section class="page reading panel">
    <div class="progress-top"><span class="tag">${escaped(sectionLabel(q.unit))}</span><span class="count-line">第 ${index + 1}／${items.length} 題</span></div>
    <progress value="${index + 1}" max="${items.length}" aria-label="練習進度"></progress>
    <div class="meta">${escaped(sourceLabel(q))} · ${escaped(q.label)} · ${types[q.type]}</div>
    ${context(q)}
    <h1 class="prompt" tabindex="-1">${rich(q.prompt)}</h1>
    <form id="answer-form">${entry(q, response)}</form>
    ${submission ? solution(q, submission) : ''}
    <div class="actions question-actions">
      <button type="button" class="btn" data-action="previous" ${index === 0 ? 'disabled' : ''}>上一題</button>
      ${!submission ? '<button type="button" class="btn" data-action="next">跳過</button><button type="submit" form="answer-form" class="btn primary">送出答案</button>' :
        needsReview ? '<button type="button" class="btn" data-action="judge-wrong">答錯／待複習</button><button type="button" class="btn primary" data-action="judge-right">答對了</button>' :
          `<button type="button" class="btn primary" data-action="next">${index === items.length - 1 ? '查看結果' : '下一題'}</button>`}
    </div>
  </section>`, focus);
}
const superscripts = '⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺';
function textual(value) {
  const node = document.createElement('template');
  node.innerHTML = rich(value);
  const visit = el => {
    if (el.nodeType === 3) return el.nodeValue;
    const tag = el.localName;
    const kids = Array.from(el.childNodes, visit);
    if (tag === 'annotation' || tag === 'img') return '';
    if (tag === 'mfrac') return `(${kids[0]})/(${kids[1]})`;
    if (tag === 'msqrt') return `√(${kids.join('')})`;
    if (tag === 'msub' || tag === 'sub') return tag === 'sub' ? '_' + kids.join('') : `${kids[0]}_${kids[1]}`;
    if (tag === 'msubsup') return `${kids[0]}_${kids[1]}^${kids[2]}`;
    if (tag === 'msup' || tag === 'sup') {
      const exponent = tag === 'sup' ? kids.join('') : kids[1];
      const text = /^[-+−\d]+$/.test(exponent) ? [...exponent].map(c => {
        const index = '0123456789-+'.indexOf(c === '−' ? '-' : c);
        return superscripts[index];
      }).join('') : '^(' + exponent + ')';
      return tag === 'sup' ? text : kids[0] + text;
    }
    return kids.join('');
  };
  return Array.from(node.content.childNodes, visit).join('')
    .replace(/[  -​  ]/g, ' ').replace(/[∙]/g, '·').replace(/∼/g, '~');
}
const choicesOnly = value => /^(?:\(?[A-E]\)?[、,，.．\s]*)+$/i.test(value.trim());
function normalize(value) {
  let clean = value.normalize('NFKC').trim().toLowerCase()
    .replace(/[−–－]/g, '-').replace(/[＊*·]/g, '×')
    .replace(/(\d)\s*[x×]\s*(?=10)/g, '$1×').replace(/\s+/g, '')
    .replace(/√(\d+)|√\((\d+)\)/g, (_, plain, wrapped) => `sqrt(${plain ?? wrapped})`);
  clean = clean.replace(/^(\(?-?\d+(?:\.\d+)?\)?)\s*(?:m\/s2|kg\/m3|m\/s|km\/h|n|j|kg|℃|cm|m|s)$/i, '$1');
  if (choicesOnly(clean)) return [...clean.replace(/[^a-e]/g, '')].sort().join('');
  if (/^(?:[甲乙丙丁戊己庚辛][、,，]*)+$/.test(clean)) return [...clean.replace(/[、,，]/g, '')].sort().join('');
  if (/^(?:\d{1,2}[.、,，]){2,}\d{0,2}$/.test(clean))
    return clean.split(/[.、,，]/).filter(Boolean).map(Number).sort((a, b) => a - b).join(',');
  return clean.replace(/[＝]/g, '=').replace(/\(([-\d.]+)\)/g, '$1');
}
function numeric(value) {
  const cleaned = value.trim().replace(/[−–－]/g, '-')
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/g, m => '^' + [...m].map(c => '0123456789-+'[superscripts.indexOf(c)]).join(''))
    .normalize('NFKC').toLowerCase().replace(/\s+/g, '').replace(/\(([-\d.]+)\)/g, '$1');
  if (/^[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/.test(cleaned)) return Number(cleaned);
  const sci = cleaned.match(/^([-+]?\d+(?:\.\d+)?)[×x*]10\^([-+]?\d+)$/);
  if (sci) return Number(sci[1]) * Math.pow(10, Number(sci[2]));
  const pow = cleaned.match(/^10\^([-+]?\d+)$/);
  if (pow) return Math.pow(10, Number(pow[1]));
  const frac = cleaned.match(/^([-+]?\d+(?:\.\d+)?)\/([-+]?\d+(?:\.\d+)?)$/);
  if (frac && +frac[2]) return Number(frac[1]) / Number(frac[2]);
  const constant = cleaned.replace(/√/g, 'sqrt').replace(/π/g, 'pi');
  const product = constant.match(/^([+-]?\d+(?:\.\d+)?)?[×*]?(?:(sqrt)\(?(\d+(?:\.\d+)?)\)?)?[×*]?(pi(?:\^2)?)?(?:\/([+-]?\d+(?:\.\d+)?))?$/);
  if (product && (product[2] || product[4])) {
    const [, factor, radical, radicand, pi, divisor] = product;
    return Number(factor ?? 1) * (radical ? Math.sqrt(Number(radicand)) : 1) *
      (pi === 'pi^2' ? Math.PI ** 2 : pi ? Math.PI : 1) / Number(divisor ?? 1);
  }
  return NaN;
}
function blankCorrect(value, expected) {
  const actualText = normalize(value);
  const expectedText = textual(expected);
  if (actualText === normalize(expectedText)) return true;
  const a = numeric(value), b = numeric(expectedText);
  if (Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) <= (b === 0 ? 1e-12 : Math.abs(b) * 0.001);
  const aliases = [
    ['公尺', '米', 'm'], ['公斤', '千克', 'kg'], ['秒', 's'], ['公分', '厘米', 'cm'], ['公克', '克', 'g'],
    ['呎', '英尺', '英呎', 'ft'], ['磅', 'lb'], ['克耳文', '開爾文', '克氏', 'k'],
    ['燭光', '坎德拉', 'cd'], ['安培', 'a'], ['莫耳', '摩爾', 'mol'],
    ['古典物理', '古典物理學'], ['近代物理', '近代物理學'], ['等速度運動', '等速度', '等速運動', '等速'], ['增大', '大', '變大'], ['減小', '小', '變小']
  ];
  return aliases.some(group => group.includes(actualText) && group.includes(normalize(expectedText)));
}
function answerValue(q, form) {
  const fields = new FormData(form);
  if (q.type === 'c') return fields.get('option');
  if (q.type === 'f') return fields.getAll('blank');
  return fields.get('written');
}
function submitAnswer(form) {
  const { items, index, responses } = state.run;
  const response = responses[index];
  if (response.submission) return;
  const q = items[index];
  const answer = answerValue(q, form);
  let correct = null;
  if (q.type === 'c') {
    if (!answer) return;
    correct = answer === q.answer;
  } else if (q.type === 'f') {
    if (answer.some(a => !a.trim())) return;
    correct = answer.every((value, index) => blankCorrect(value, q.answer[index]));
  } else {
    if (!answer?.trim()) { form.querySelector('textarea').setCustomValidity('請先輸入你的作答。'); form.reportValidity(); return; }
  }
  response.submission = { value: answer, correct };
  if (correct !== null) remember(q, correct);
  practiceView(false);
  app.querySelector('.feedback h3').setAttribute('tabindex', '-1');
  app.querySelector('.feedback h3').focus();
}
function moveQuestion(offset) {
  const run = state.run;
  const newIndex = run.index + offset;
  if (newIndex < 0) return;
  if (newIndex >= run.items.length) return go('result');
  run.index = newIndex;
  practiceView(true);
}
function resultView(focus) {
  if (!state.run) return unitsView(focus);
  const { items, responses, isWrong } = state.run;
  const right = responses.filter(r => r.submission?.correct === true).length;
  const missed = responses.filter(r => r.submission?.correct === false).length;
  draw(`<section class="page reading panel">
    ${heading('練習結果')}
    <div class="totals"><div class="total"><strong>${right}</strong>答對</div><div class="total"><strong>${missed}</strong>答錯</div><div class="total"><strong>${items.length - right - missed}</strong>未作答</div></div>
    <div class="actions"><a class="btn primary" href="#${isWrong ? 'wrong' : 'units'}">${isWrong ? '返回錯題本' : '返回單元'}</a><a class="btn" href="#practice">回看最後一題</a><a class="btn" href="#wrong">查看錯題本</a></div>
  </section>`, focus);
}
function visibleWrong() { return wrong().filter(q => !state.wrongChapter || q.unit.startsWith(state.wrongChapter + '-')); }
function refreshWrongControls() {
  const count = state.wrongSelected.size;
  const countText = app.querySelector('#wrong-count');
  if (countText) countText.textContent = '已選 ' + count + ' 題';
  for (const action of ['pdf', 'retry-wrong']) {
    const button = app.querySelector(`[data-action="${action}"]`);
    if (button) button.disabled = !count;
  }
}
function wrongView(focus) {
  const all = wrong();
  const visible = visibleWrong();
  draw(`<section class="page reading panel">
    <div class="section-head"><div>${heading('錯題本')}<p class="note">${state.account ? '歷次答錯的題目都會保留。' : '訪客紀錄儲存在這個瀏覽器。'}</p></div><span class="tag" id="sync-status">${escaped(state.status)}</span></div>
    ${all.length ? `<div class="filter-grid"><label class="field">章節<select id="wrong-chapter"><option value="">全部章節</option>${state.chapters.map(c => `<option value="${c.id}" ${c.id === state.wrongChapter ? 'selected' : ''}>${c.id}　${escaped(c.name)}</option>`).join('')}</select></label></div>
    <div class="actions"><button class="btn" data-action="select-wrong">全選顯示題目</button><button class="btn" data-action="clear-wrong">清除勾選</button><span class="count-line" id="wrong-count"></span></div>
    <div class="actions"><button class="btn primary" data-action="pdf">下載 A4 PDF</button><button class="btn" data-action="retry-wrong">重做選取題目</button><label><input type="checkbox" id="solutions" checked> 附答案與詳解</label></div>
    <p id="export-status" class="note" role="status"></p>
    ${visible.map(q => `<article class="wrong-item"><label class="subrow"><input type="checkbox" name="wrong" value="${q.id}" ${state.wrongSelected.has(q.id) ? 'checked' : ''}><span><strong>${escaped(sectionLabel(q.unit))}</strong> · ${escaped(q.label)}<br><span class="meta">${escaped(sourceLabel(q))} · 答錯 ${state.records[q.id].wrong} 次</span></span></label>
      <details><summary>展開題目與詳解</summary><div class="detail">${context(q)}<div class="prompt">${rich(q.prompt)}</div>${q.options ? `<div class="static-options">${optionsHTML(q, { staticOnly: true })}</div>` : ''}${solution(q)}</div></details></article>`).join('') || '<p class="note">這一章沒有錯題。</p>'}`
      : '<p>目前沒有錯題。完成一次練習後，答錯的題目會出現在這裡。</p><a class="btn primary" href="#units">前往單元練習</a>'}
  </section>`, focus);
  refreshWrongControls();
}
function accountView(focus) {
  const totals = recordCount();
  const mode = state.loginMode;
  const register = mode === 'register';
  draw(`<section class="page account-page panel">
    ${heading(state.account ? '我的紀錄' : '學生帳號')}
    ${state.account ? `<p class="note">已登入 ${escaped(state.account.name)} · <span id="sync-status">${escaped(state.status)}</span></p>
    <div class="totals"><div class="total"><strong>${totals.right}</strong>答對</div><div class="total"><strong>${totals.wrong}</strong>答錯</div><div class="total"><strong>${wrong().length}</strong>錯題</div></div>
    <div class="actions"><button class="btn" data-action="sync">重新同步</button>${state.status === '請重新登入以同步' ? '<button class="btn" data-action="relogin">重新登入</button>' : ''}<button class="btn" data-action="logout">登出</button></div>`
    : `<p class="note">用相同代稱和密碼登入，即可在手機、平板和電腦查看自己的錯題。</p>
    <div class="segment" aria-label="帳號功能"><button class="${radioStyle(!register)}" aria-pressed="${!register}" data-action="login-mode">登入</button><button class="${radioStyle(register)}" aria-pressed="${register}" data-action="register-mode">註冊</button></div>
    <form id="account-form">
      <label class="field">帳號代稱<input name="name" required minlength="3" maxlength="24" autocomplete="username" autocapitalize="none" spellcheck="false"></label>
      <label class="field">密碼<input name="password" required type="password" minlength="8" maxlength="128" autocomplete="${register ? 'new-password' : 'current-password'}"></label>
      ${register ? '<p class="note">請使用代稱和至少 8 個字元的密碼。請妥善保管密碼，本服務以代稱註冊，沒有電子郵件重設功能。</p>' : ''}
      <div class="actions"><button class="btn primary" type="submit">${register ? '建立帳號' : '登入'}</button><a class="btn" href="#units">先練習</a></div>
      <p class="error" id="login-error" role="alert" hidden></p>
    </form>`}
  </section>`, focus);
}
async function submitAccount(form) {
  const data = new FormData(form);
  const button = form.querySelector('button[type=submit]');
  const box = form.querySelector('#login-error');
  button.disabled = true;
  box.hidden = true;
  try {
    const account = await api('/' + state.loginMode, { body: { name: data.get('name'), password: data.get('password') } });
    state.account = account;
    store('account', account, sessionStorage);
    state.wrongSelected.clear();
    loadLocal();
    go('units');
    void sync();
  } catch (error) {
    box.textContent = humanError(error);
    box.hidden = false;
    button.disabled = false;
  }
}
async function logout(send = true) {
  if (send && state.account) {
    await sync();
    try { await api('/logout', { token: state.account.token, body: {} }); } catch { /* The local session can still end. */ }
  }
  state.account = null;
  state.sync = null;
  state.status = '';
  state.wrongSelected.clear();
  store('account', null, sessionStorage);
  loadLocal();
  go('account');
}

let pdfLibrary;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
}
function imageData(file) {
  return fetch('assets/figures/' + file).then(response => {
    if (!response.ok) throw new Error('figure');
    return response.blob();
  }).then(blob => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  }));
}
async function pdfBlocks(content, options = {}) {
  const blocks = await Promise.all(String(content).split(/(\{\{img:[^{}]+\}\})/g).map(async part => {
    if (part.startsWith('{{img:')) return { image: await imageData(part.slice(6, -2)), fit: [440, options.figureHeight || 156], margin: [0, 4, 0, 4] };
    const text = textual(part).trim();
    return text ? { text, margin: [0, 2, 0, 2] } : null;
  }));
  return blocks.filter(Boolean);
}
async function pdfSolution(content) {
  const out = [];
  for (const block of solutionBlocks(content)) {
    if (block.kind === 'head') out.push({ text: block.text, color: '#086b58', margin: [0, 6, 0, 2] });
    else if (block.kind === 'text') out.push(...await pdfBlocks(block.text));
    else {
      const columns = block.head.length;
      const cell = (value, header) => {
        const text = textual(value.replace(/\{\{img:[^{}]+\}\}/g, '（見圖）')).trim();
        const color = header ? '#103d35' : value.startsWith('○') ? '#086b58' : value.startsWith('×') ? '#a12f32' : undefined;
        return { text, ...(color ? { color } : {}), ...(header ? { fillColor: '#e8f2ef' } : {}) };
      };
      const body = [block.head.map(value => cell(value, true)),
        ...block.body.map(cells => Array.from({ length: columns }, (_, i) => cell(cells[i] ?? '', false)))];
      out.push({
        table: { headerRows: 1, widths: Array.from({ length: columns }, (_, i) => columns <= 3 && i < columns - 1 ? 'auto' : '*'), body },
        layout: { hLineColor: () => '#cfe0db', vLineColor: () => '#cfe0db', paddingTop: () => 3, paddingBottom: () => 3 },
        fontSize: 9.5, margin: [0, 3, 0, 5]
      });
    }
  }
  return out;
}
async function printBook(items, includeSolutions) {
  const area = document.createElement('section');
  area.id = 'printout';
  area.innerHTML = `<h1>物理 B 上 錯題本</h1><p>${items.length} 題 · ${new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei' }).format(new Date())}</p>` +
    items.map((q, i) => `<article class="print-item"><h2>${i + 1}. ${escaped(sectionLabel(q.unit))}　${escaped(sourceLabel(q))}・${escaped(q.label)}</h2>
      ${context(q)}<div class="prompt">${rich(q.prompt)}</div>${q.options ? `<div class="static-options">${optionsHTML(q, { staticOnly: true })}</div>` : ''}${includeSolutions ? solution(q) : '<div class="worksheet-space"></div>'}</article>`).join('');
  document.querySelector('#printout')?.remove();
  document.body.append(area);
  await Promise.all([...area.querySelectorAll('img')].map(img => img.decode().catch(() => {})));
  window.print();
}
async function downloadBook() {
  const items = wrong().filter(q => state.wrongSelected.has(q.id));
  if (!items.length) return;
  const includeSolutions = app.querySelector('#solutions').checked;
  const notice = app.querySelector('#export-status');
  const button = app.querySelector('[data-action="pdf"]');
  button.disabled = true;
  notice.textContent = '正在製作 A4 PDF…';
  try {
    pdfLibrary ||= loadScript('assets/vendor/pdfmake.min.js');
    await pdfLibrary;
    if (!window.pdfMake) throw new Error('pdf library');
    const font = 'assets/vendor/PhysicsTC.otf';
    window.pdfMake.addFonts({ Physics: { normal: new URL(font, location.href).href } });
    const content = [
      { text: '物理 B 上　錯題本', fontSize: 23, color: '#103d35' },
      { text: `${items.length} 題　·　${new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei' }).format(new Date())}`, color: '#52676a', margin: [0, 3, 0, 15] }
    ];
    for (const [index, q] of items.entries()) {
      const stack = [
        { text: `${index + 1}. ${sectionLabel(q.unit)}　${sourceLabel(q)} · ${q.label}`, color: '#086b58', margin: [0, 0, 0, 4] }
      ];
      if (q.context) stack.push(...await pdfBlocks(q.context));
      stack.push(...await pdfBlocks(q.prompt));
      for (const [idx, option] of (q.options || []).entries()) {
        stack.push(...await pdfBlocks(`(${letters[idx]}) ${option}`, { figureHeight: 77 }));
      }
      if (includeSolutions) {
        const answer = q.type === 'c' ? q.answer : q.type === 'f' ? q.answer.map((v, i) => `(${i + 1}) ${v}`).join('；') : q.answer;
        if (answer) stack.push(...await pdfBlocks('答案　' + answer));
        stack.push({ text: '詳解', color: '#086b58', margin: [0, 4, 0, 0] });
        stack.push(...await pdfSolution(q.workedExplanation ?? q.explanation));
        const guide = textbookGuide(q);
        if (guide) {
          stack.push(...await pdfBlocks('解題觀念　' + guide.explanation));
          for (const link of guide.links) {
            stack.push({ text: link.text, link: new URL(link.href, location.href).href,
              color: '#086b58', decoration: 'underline', margin: [0, 2, 0, 3] });
          }
        }
      } else {
        stack.push({ text: '作答　________________________________________', color: '#52676a', margin: [0, 5, 0, 0] });
      }
      content.push({ stack, unbreakable: !includeSolutions, margin: [0, 0, 0, 13] });
    }
    const doc = window.pdfMake.createPdf({
      pageSize: 'A4', pageMargins: [44, 42, 44, 46],
      defaultStyle: { font: 'Physics', fontSize: 10.5, lineHeight: 1.2 },
      footer: (page, total) => ({ text: `${page} / ${total}`, alignment: 'center', fontSize: 9, color: '#52676a', margin: [0, 15, 0, 0] }),
      content
    });
    const pdf = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('pdf timeout')), 25000);
      doc.getBlob(blob => { clearTimeout(timeout); resolve(blob); });
    });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(pdf);
    link.download = '物理B上-A4錯題本.pdf';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
    notice.textContent = 'A4 PDF 已產生。';
  } catch {
    pdfLibrary = null;
    notice.textContent = '下載暫時無法使用，已開啟 A4 列印畫面。';
    await printBook(items, includeSolutions);
  } finally {
    if (button.isConnected) button.disabled = !state.wrongSelected.size;
  }
}

function render(focus = false) {
  if (!state.bank.length) return;
  updateNav();
  const views = { units: unitsView, practice: practiceView, result: resultView, wrong: wrongView, account: accountView };
  (views[current()] || unitsView)(focus);
}
app.addEventListener('change', event => {
  const { name, value, checked, id } = event.target;
  if (name === 'section') {
    if (checked) state.selected.add(value);
    else state.selected.delete(value);
    refreshUnitControls();
  }
  if (['source', 'type', 'count'].includes(name)) {
    state[name] = value;
    refreshUnitControls();
  }
  if (name === 'shuffle') state.order = checked ? 'random' : 'original';
  if (name === 'wrong') {
    if (checked) state.wrongSelected.add(value);
    else state.wrongSelected.delete(value);
    refreshWrongControls();
  }
  if (id === 'wrong-chapter') { state.wrongChapter = value; wrongView(false); }
  if (id === 'mobile-chapter') setChapter(value);
});
app.addEventListener('input', event => {
  const input = event.target;
  if (input.form?.id !== 'answer-form') return;
  if (input.name === 'written') input.setCustomValidity('');
  const { items, index, responses } = state.run;
  const response = responses[index];
  if (!response.submission) response.draft = answerValue(items[index], input.form);
});
app.addEventListener('submit', event => {
  event.preventDefault();
  if (event.target.id === 'answer-form') submitAnswer(event.target);
  if (event.target.id === 'account-form') void submitAccount(event.target);
});
app.addEventListener('click', event => {
  const chapter = event.target.closest('[data-chapter]');
  if (chapter) return setChapter(chapter.dataset.chapter);
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  switch (action) {
    case 'toggle-sections': {
      const fields = [...app.querySelectorAll('[name="section"]')];
      const value = !fields.every(input => input.checked);
      fields.forEach(input => {
        input.checked = value;
        if (value) state.selected.add(input.value);
        else state.selected.delete(input.value);
      });
      refreshUnitControls();
      break;
    }
    case 'start': start(filterQuestions()); break;
    case 'previous': moveQuestion(-1); break;
    case 'next': moveQuestion(1); break;
    case 'judge-right':
    case 'judge-wrong': {
      const run = state.run;
      const submission = run.responses[run.index].submission;
      if (submission?.correct !== null) break;
      const correct = action === 'judge-right';
      submission.correct = correct;
      remember(run.items[run.index], correct);
      moveQuestion(1);
      break;
    }
    case 'select-wrong':
      visibleWrong().forEach(q => state.wrongSelected.add(q.id));
      app.querySelectorAll('[name="wrong"]').forEach(input => { input.checked = true; });
      refreshWrongControls();
      break;
    case 'clear-wrong':
      state.wrongSelected.clear();
      app.querySelectorAll('[name="wrong"]').forEach(input => { input.checked = false; });
      refreshWrongControls();
      break;
    case 'retry-wrong': start(wrong().filter(q => state.wrongSelected.has(q.id)), true); break;
    case 'pdf': void downloadBook(); break;
    case 'sync': void sync(); break;
    case 'logout': button.disabled = true; void logout(); break;
    case 'relogin': void logout(false); break;
    case 'login-mode':
    case 'register-mode': state.loginMode = action.split('-')[0]; accountView(false); break;
  }
});
window.addEventListener('hashchange', () => render(true));
window.addEventListener('online', () => { if (state.account) void sync(); });
window.addEventListener('storage', event => {
  const name = state.account?.name || '@guest';
  if (event.key !== 'physics:' + recordsKey(name)) return;
  loadLocal();
  if (current() === 'wrong') render(false);
  else updateNav();
});
setInterval(() => {
  if (state.account && state.status !== '請重新登入以同步' && pending(state.account.name).length) void sync();
}, 30000);

try {
  const response = await fetch('./questions.json');
  if (!response.ok) throw new Error('bank');
  const { questions, archivedQuestions, chapters, questionAliases, publisherChapters, textbookTopics } = await response.json();
  state.bank = questions;
  state.archivedQuestions = archivedQuestions ?? [];
  state.chapters = chapters;
  state.questionAliases = new Map(Object.entries(questionAliases ?? {}));
  state.publisherChapters = publisherChapters ?? {};
  state.textbookTopics = textbookTopics ?? {};
  state.selected = new Set(chapters[0].sections.map(section => section.id));
  loadLocal();
  render();
  if (state.account) void sync();
} catch {
  draw('<section class="page panel"><h1>題庫暫時無法載入</h1><p>請重新整理網頁後再試。</p></section>');
}
