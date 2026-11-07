// Точная диагностика вертикального ритма (текущее состояние файла).
// 1) Для каждой границы раздела: нижний край последнего блока пред. секции → линия .divider → верх первого блока след. секции,
//    с разбивкой по margins/padding каждого участника.
// 2) Скриншоты двух характерных границ (hero→bigo, bigo→arrays).
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { CDP, httpGet, waitForChrome, sleep } from './cdp-raw.mjs';

const CHROME = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const PORT = 9300 + Math.floor(Math.random() * 1000);
const PAGE = 'file:///' + path.join(process.cwd(), 'index.html')
  .replace(/\\/g, '/').replace(/[^\x20-\x7e]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  .replace(/ /g, '%20').replace(/&/g, '%26');
const SHOTS = path.join(process.cwd(), 'shots');

const evalJs = async (cdp, expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error('ошибка evaluate в странице: ' + JSON.stringify(r.exceptionDetails));
  if ('value' in r.result || r.result.type === 'undefined') return r.result.value;
  throw new Error('evaluate без значения: ' + JSON.stringify(r));
};

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(os.tmpdir(), 'algo-cdp-gap2-' + Date.now())}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1440,900', PAGE,
], { stdio: 'ignore' });

try {
  await waitForChrome(PORT);
  const list = JSON.parse((await httpGet(`http://127.0.0.1:${PORT}/json`)).body);
  const page = list.find((t) => t.type === 'page' && t.url.startsWith('file:///'));
  if (!page) throw new Error('не найден page-target с file:// URL');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // Ждём загрузки и «замораживаем» reveal-анимации: все .rv видимы, без transform.
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if ((await evalJs(cdp, 'document.readyState')) === 'complete') break;
    await sleep(250);
  }
  await evalJs(cdp, `(() => {
    const st = document.createElement('style');
    st.textContent = '*{transition:none !important;animation:none !important} .rv{opacity:1 !important;transform:none !important}';
    document.head.appendChild(st); return 'ok';
  })()`);
  await sleep(300);

  const MEASURE = `(() => {
    const cs = (el, p) => getComputedStyle(el)[p];
    const r = (el) => el.getBoundingClientRect();
    const ids = ['hero','bigo','arrays-lists','recursion-stack','sorting','hash-tables','trees-heaps','graphs-bfs','dijkstra','greedy-np','distributed-systems'];
    const secs = ids.map((id) => document.getElementById(id)).filter(Boolean);
    const out = [];
    for (let i = 0; i < secs.length - 1; i++) {
      const A = secs[i], B = secs[i + 1];
      const cA = A.querySelector(':scope > .container');
      const kidsA = Array.from((cA || A).children).filter((el) => r(el).height > 0);
      const lastA = kidsA[kidsA.length - 1];
      const cB = B.querySelector(':scope > .container');
      const kidsB = Array.from((cB || B).children).filter((el) => r(el).height > 0);
      const firstB = kidsB[0];
      let divEl = A.nextElementSibling;
      while (divEl && !(divEl.classList && divEl.classList.contains('divider'))) { if (divEl.nodeType === 1) break; divEl = divEl.nextSibling; }
      const row = {
        boundary: ids[i] + ' -> ' + ids[i + 1],
        lastA: (lastA.id || '.' + String(lastA.className).split(' ').slice(0, 2).join('.')),
        firstB: (firstB.id || '.' + String(firstB.className).split(' ').slice(0, 2).join('.')),
        A_pad: cs(A,'paddingTop') + '/' + cs(A,'paddingBottom'),
        B_pad: cs(B,'paddingTop') + '/' + cs(B,'paddingBottom'),
      };
      if (divEl) { row.gapAbove = +(r(divEl).top - r(lastA).bottom).toFixed(2); row.lineY = +r(divEl).top.toFixed(1); row.gapBelow = +(r(firstB).top - r(divEl).bottom).toFixed(2); }
      else { row.noDivider = true; row.totalGap = +(r(firstB).top - r(lastA).bottom).toFixed(2); }
      out.push(row);
    }
    const inner = [];
    for (const s of secs) {
      if (s.id === 'hero') continue;
      const c = s.querySelector(':scope > .container');
      const kids = Array.from(c.children).filter((el) => r(el).height > 0);
      for (let i = 0; i < Math.min(kids.length - 1, 3); i++) {
        inner.push({ sec: s.id, from: (kids[i].id || '.' + String(kids[i].className).split(' ').slice(0,2).join('.')), to: (kids[i+1].id || '.' + String(kids[i+1].className).split(' ').slice(0,2).join('.')), gap: +(r(kids[i+1]).top - r(kids[i]).bottom).toFixed(2) });
      }
    }
    const key = {
      secPad: cs(secs[1], 'paddingTop') + '/' + cs(secs[1], 'paddingBottom'),
      heroPad: cs(document.getElementById('hero'), 'paddingTop') + '/' + cs(document.getElementById('hero'), 'paddingBottom'),
      secHeadMB: cs(document.querySelector('.sec-head'), 'marginBottom'),
      topicCardMB: cs(document.querySelector('.topic-card'), 'marginBottom'),
      gapVar: getComputedStyle(document.documentElement).getPropertyValue('--gap').trim(),
    };
    const foot = document.querySelector('footer');
    let footInfo = null;
    if (foot) {
      const fR = r(foot);
      const allSecs = Array.from(document.querySelectorAll('main > section'));
      const lastSecEl = allSecs[allSecs.length - 1];
      const cL = lastSecEl.querySelector(':scope > .container') || lastSecEl;
      const kidsL = Array.from(cL.children).filter((el) => r(el).height > 0);
      const lastB = kidsL[kidsL.length - 1];
      const fc = getComputedStyle(foot);
      footInfo = {
        gap: +(fR.top - r(lastB).bottom).toFixed(2),
        lastBlock: (lastB.id || '.' + String(lastB.className).split(' ').slice(0, 2).join('.')),
        marginTop: fc.marginTop, padding: fc.padding,
        radius: fc.borderRadius, border: fc.borderColor,
        bg: fc.backgroundColor, blur: fc.backdropFilter || 'none',
        shadow: String(fc.boxShadow).slice(0, 90),
        pageBottomGap: +(document.documentElement.scrollHeight - fR.bottom).toFixed(2)
      };
    }
    return { vh: innerHeight, vw: innerWidth, out, inner, key, footInfo };
  })()`;
  const M = await evalJs(cdp, MEASURE);
  console.log(`viewport ${M.vw}x${M.vh}; section padding=${M.key.secPad}, hero pad=${M.key.heroPad}, .sec-head mb=${M.key.secHeadMB}, .topic-card mb=${M.key.topicCardMB}, --gap=${M.key.gapVar}`);
  console.log('');
  console.log('-- ГРАНИЦЫ МЕЖДУ СЕКЦИЯМИ (px) --');
  for (const b of M.out) {
    if (b.noDivider) console.log(`${b.boundary}: БЕЗ divider, totalGap=${b.totalGap} | lastA=${b.lastA} firstB=${b.firstB}`);
    else console.log(`${b.boundary}: above-line=${b.gapAbove}  line@${b.lineY}  below-line=${b.gapBelow} | A_pad=${b.A_pad} B_pad=${b.B_pad} | lastA=${b.lastA} firstB=${b.firstB}`);
  }
  console.log('');
  console.log('-- ВНУТРИ СЕКЦИЙ: первые 3 зазора --');
  for (const g of M.inner) console.log(`${g.sec}: ${g.from} -> ${g.to} = ${g.gap}px`);

  if (M.footInfo) {
    const f = M.footInfo;
    console.log('');
    console.log('-- ФУТЕР --');
    console.log(`gap: ${f.lastBlock} -> footer = ${f.gap}px | до низа страницы = ${f.pageBottomGap}px`);
    console.log(`margin-top=${f.marginTop} padding=${f.padding}`);
    console.log(`radius=${f.radius} border-color=${f.border}`);
    console.log(`bg=${f.bg} blur=${f.blur}`);
    console.log(`shadow=${f.shadow}`);
  }

  // Скриншоты двух характерных границ (кадр центрирован на divider)
  const shot = async (name, scrollYExpr) => {
    await evalJs(cdp, `document.documentElement.style.scrollBehavior='auto'; window.scrollTo(0, ${scrollYExpr}); document.documentElement.style.scrollBehavior=''`);
    await sleep(450);
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, name), Buffer.from(s.data, 'base64'));
    console.log(`shot: ${name} (scrollY=${await evalJs(cdp, 'window.scrollY')})`);
  };
  const d0 = M.out[0].lineY || 0, d1 = M.out[1].lineY || 0;
  await shot('gap2-hero-bigo.png', `${d0} - ${M.vh / 2}`);
  await shot('gap2-bigo-arrays.png', `${d1} - ${M.vh / 2}`);
  if (M.footInfo) await shot('gap2-footer.png', 'document.documentElement.scrollHeight');
} catch (e) {
  console.error('ОШИБКА:', e.message || e);
  process.exitCode = 1;
} finally {
  chrome.kill('SIGKILL');
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref();
}

