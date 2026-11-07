// Диагностика headless Chrome (без зависимостей; CDP — ./cdp-raw.mjs):
// A) ошибки консоли/исключения при свежей загрузке (Runtime/Page включены до reload);
// B) reveal на scrollY=0: сколько .rv в effective root и сколько уже с .vis;
// C) программный скролл к 3000 → вырос ли счётчик .vis (IO жив при scroll?);
// D) прямой page-side IO-probe: свой элемент + IntersectionObserver (тот же rootMargin);
// E/F) sticky sidebar: цепочка предков (position/overflow) + top до и после body overflow-фикса.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { CDP, httpGet, waitForChrome, sleep } from './cdp-raw.mjs';

const CHROME = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const PORT = 9400 + Math.floor(Math.random() * 1000);
const PAGE =
  'file:///' +
  path
    .join(process.cwd(), 'index.html')
    .replace(/\\/g, '/')
    .replace(/[^\x20-\x7e]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/ /g, '%20')
    .replace(/&/g, '%26');

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(os.tmpdir(), 'algo-cdp-diag-' + Date.now())}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1440,900',
    PAGE,
  ],
  { stdio: 'ignore' }
);

let exitCode = 0;
try {
  const ver = await waitForChrome(PORT);
  console.log('browser:', ver.Browser);
  const list = JSON.parse((await httpGet(`http://127.0.0.1:${PORT}/json`)).body);
  const page = list.find((t) => t.type === 'page' && t.url.startsWith('file:///'));
  if (!page) throw new Error('не найден page-target с file:// URL');

  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect();

  // A) включаем до reload, чтобы поймать ошибки при загрузке страницы
  const consoleErrors = [];
  const exceptions = [];
  cdp.onEvent((ev) => {
    if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error')
      consoleErrors.push(JSON.stringify(ev.params.args || []));
    else if (ev.method === 'Runtime.exceptionThrown')
      exceptions.push(String((ev.params.exceptionDetails?.exception?.description) || JSON.stringify(ev.params.exceptionDetails)));
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('ошибка evaluate в странице: ' + JSON.stringify(r.exceptionDetails));
    if ('value' in r.result || r.result.type === 'undefined') return r.result.value;
    throw new Error('evaluate без значения: ' + JSON.stringify(r));
  };

  await cdp.send('Page.reload', { ignoreCache: true });
  for (let i = 0; i < 40; i++) {
    const rs = await evalJs('document.readyState');
    if (rs === 'complete') break;
    await sleep(250);
  }
  console.log('\n--- A) ошибки консоли/исключения при загрузке ---');
  console.log('console.error:', consoleErrors.length ? '\n' + consoleErrors.join('\n') : 'нет');
  console.log('exceptions:   ', exceptions.length ? '\n' + exceptions.join('\n') : 'нет');

  // B) reveal на scrollY=0
  const b = await evalJs(`(() => {
    let total = 0, vis = 0, inView = 0, visInView = 0;
    for (const e of document.querySelectorAll('.rv')) {
      if (e.getBoundingClientRect().width === 0) continue;
      total++;
      const v = e.classList.contains('vis');
      if (v) vis++;
      const r = e.getBoundingClientRect();
      if (r.top < innerHeight * 0.96 && r.bottom > innerHeight * 0.04) { inView++; if (v) visInView++; }
    }
    return { scrollY: Math.round(window.scrollY), total, vis, inView, visInView };
  })()`);
  console.log('\n--- B) reveal на scrollY=0 ---', JSON.stringify(b));

  // C) программный скролл к 3000 → изменился ли счётчик .vis
  await evalJs('window.scrollTo({top:3000, behavior:"instant"})');
  await sleep(800);
  const c1 = await evalJs(`(() => ({ scrollY: Math.round(window.scrollY), vis: document.querySelectorAll('.rv.vis').length }))()`);
  console.log('\n--- C) после мгновенного скролла к 3000 (через 800 мс) ---', JSON.stringify(c1));
  // D) прямой IO-probe, независимый от кода страницы
  const ioProbe = await evalJs(`new Promise((resolve) => {
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;left:0;width:60px;height:60px;visibility:hidden;top:' + (document.documentElement.scrollHeight - 150) + 'px';
    document.body.appendChild(el);
    let fired = false, firstState = null;
    const io = new IntersectionObserver((es) => {
      es.forEach((e) => { if (firstState === null) firstState = e.isIntersecting; if (e.isIntersecting) fired = true; });
    }, { rootMargin: '-4% 0px -4% 0px' });
    io.observe(el);
    setTimeout(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }), 300);
    setTimeout(() => { try { io.disconnect(); } catch {} el.remove(); resolve({ fired, firstState, scrollY: Math.round(window.scrollY) }); }, 2500);
  })`);
  console.log('\n--- D) прямой IO-probe (свой элемент + observer, тот же rootMargin) ---', JSON.stringify(ioProbe));

  // E) sticky sidebar: цепочка предков с position/overflow
  const chain = await evalJs(`(() => {
    const out = [];
    let el = document.querySelector('.sidebar');
    while (el) {
      const cs = getComputedStyle(el);
      const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
      out.push({ node: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls, pos: cs.position, ox: cs.overflowX, oy: cs.overflowY, display: cs.display });
      if (el.tagName === 'HTML') break;
      el = el.parentElement;
    }
    return out;
  })()`);
  const curSy = await evalJs('Math.round(window.scrollY)');
  console.log('\n--- E) цепочка предков .sidebar (scrollY=' + curSy + ') ---');
  chain.forEach((x) => console.log(JSON.stringify(x)));

  // F) причинная проверка sticky: текущее (исправленное) состояние → top≈86;
  //     затем симулируем старый баг body{overflow-x:hidden} → top уходит в минус;
  //     снимаем симуляцию → снова ≈86.
  const topOf = `Math.round(document.querySelector('.sidebar').getBoundingClientRect().top)`;
  const nowTop = await evalJs(topOf);
  await evalJs('document.body.style.overflowX = "hidden"');
  await sleep(250);
  const withBodyHidden = await evalJs(topOf);
  await evalJs('document.body.style.overflowX = ""');
  await sleep(250);
  const restoredTop = await evalJs(topOf);
  console.log('\n--- F) sticky top: исправленный CSS=' + nowTop + '; с симуляцией body overflow-x:hidden → ' + withBodyHidden + '; после снятия симуляции → ' + restoredTop + ' ---');

  cdp.close();
} catch (e) {
  console.error('FATAL:', e.message);
  exitCode = 2;
} finally {
  chrome.kill();
}
process.exit(exitCode);
