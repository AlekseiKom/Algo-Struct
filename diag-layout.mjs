// Диагностика desktop-вёрстки (headless Chrome, CDP — ./cdp-raw.mjs):
// 1) геометрия: sidebar / hero-glass / карточки / колонки main-content;
// 2) расстояния: блок→sidebar (горизонталь), вертикальные зазоры внутри #bigo;
// 3) неровные inline-margin у вставок; 4) параметры reveal-системы.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { CDP, httpGet, waitForChrome, sleep } from './cdp-raw.mjs';

const CHROME = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const PORT = 9400 + Math.floor(Math.random() * 1000);
const VW = parseInt(process.env.VW || '1536', 10);
const VH = parseInt(process.env.VH || '900', 10);
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
    `--user-data-dir=${path.join(os.tmpdir(), 'algo-cdp-layout-' + Date.now())}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=' + VW + ',' + VH,
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
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error('ошибка evaluate: ' + JSON.stringify(r.exceptionDetails));
    if ('value' in r.result || r.result.type === 'undefined') return r.result.value;
    throw new Error('evaluate без значения: ' + JSON.stringify(r));
  };

  await cdp.send('Page.reload', { ignoreCache: true });
  for (let i = 0; i < 40; i++) {
    const rs = await evalJs('document.readyState');
    if (rs === 'complete') break;
    await sleep(250);
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
  await evalJs('window.scrollTo(0, 0)');
  await sleep(400);

  console.log('\n--- 1) геометрия (px; t/b — от верха документа) ---');
  const geom = await evalJs(`(() => {
    const pick = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top + scrollY), b: Math.round(r.bottom + scrollY), w: Math.round(r.width) }; };
    return {
      vw: innerWidth,
      appLayout: pick('.app-layout'),
      sidebar: pick('.sidebar'),
      mainContent: pick('.main-content'),
      heroSection: pick('#hero'),
      heroContainer: pick('#hero .container'),
      heroInner: pick('.hero-inner'),
      card1: pick('#bigo .topic-card'),
      graphWrap: pick('#dijkstra .graph-svg-wrap, #greedy-np .graph-svg-wrap'),
      gapVar: getComputedStyle(document.documentElement).getPropertyValue('--gap').trim(),
    };
  })()`);
  console.log(JSON.stringify(geom, null, 2));

  if (geom.sidebar && geom.card1) {
    const hGap = geom.card1.l - geom.sidebar.r;
    console.log(`\n>>> GAP блок→sidebar = ${hGap}px ; --gap = ${geom.gapVar}`);
    console.log(`>>> hero.w=${geom.heroSection?.w}  card1.w=${geom.card1.w}  Δ=${(geom.heroSection?.w || 0) - geom.card1.w}px`);
    console.log(`>>> hero.l=${geom.heroSection?.l} card1.l=${geom.card1.l}`);
    if (geom.heroInner && geom.card1) console.log(`>>> hero-inner.w=${geom.heroInner.w} vs card1.w=${geom.card1.w}`);
  }
  console.log('\n--- 2) вертикальный ритм внутри #bigo (прямые дети .container) ---');
  const rhythm = await evalJs(`(() => {
    const c = document.querySelector('#bigo .container');
    if (!c) return null;
    const kids = Array.from(c.children);
    const out = [];
    for (let i = 0; i < kids.length - 1; i++) {
      const a = kids[i].getBoundingClientRect();
      const b = kids[i + 1].getBoundingClientRect();
      const csA = getComputedStyle(kids[i]);
      const inlineB = kids[i + 1].getAttribute('style') || '';
      out.push({
        from: (kids[i].id || kids[i].className || kids[i].tagName).toString().slice(0, 34),
        to: (kids[i + 1].id || kids[i + 1].className || kids[i + 1].tagName).toString().slice(0, 34),
        gap: Math.round(b.top - a.bottom),
        prevMB: csA.marginBottom,
        nextInlineStyle: inlineB.slice(0, 60),
      });
    }
    return out;
  })()`);
  (rhythm || []).forEach((x) => console.log(`gap=${String(x.gap).padStart(5)} | ${x.from} → ${x.to} | prevMB=${x.prevMB}${x.nextInlineStyle ? ' | next.style=' + x.nextInlineStyle : ''}`));

  console.log('\n--- 3) inline-margin в main-content (неравный ритм) ---');
  const uneven = await evalJs(`(() => {
    const out = [];
    document.querySelectorAll('#mainContent [style*="margin"]').forEach((e) => {
      const m = e.getAttribute('style').match(/margin[^;:]*:\\s*[^;]+/g);
      if (m) out.push((e.className || e.tagName).toString().slice(0, 30) + ' :: ' + m.join(' ; ').slice(0, 70));
    });
    return out.slice(0, 45);
  })()`);
  console.log(`всего элементов с inline-margin: ${uneven.length}`);
  uneven.forEach((s) => console.log('  ' + s));

  console.log('\n--- 4) reveal-система (.rv) ---');
  const rv = await evalJs(`(() => {
    const e0 = document.querySelector('.rv');
    const cs = getComputedStyle(e0);
    return {
      transition: cs.transition,
      opacity: cs.opacity, transform: cs.transform,
      totalRv: document.querySelectorAll('.rv').length,
      visNow: document.querySelectorAll('.rv.vis').length,
      belowFoldNotVis: Array.from(document.querySelectorAll('.rv')).filter((e) => e.getBoundingClientRect().top > innerHeight && !e.classList.contains('vis')).length,
    };
  })()`);
  console.log(JSON.stringify(rv));

  console.log('\n--- 5) ВАЛИДАЦИЯ: выравнивание и единый ритм ---');
  const verify = await evalJs(`(() => {
    // нейтрализуем reveal-трансформации (translateY(22px) искажает замеры)
    document.querySelectorAll('.rv').forEach((e) => { e.style.transition = 'none'; e.classList.add('vis'); });
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;width:var(--gap);visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);
    const gapPx = Math.round(probe.getBoundingClientRect().width);
    probe.remove();
    const rHero = document.querySelector('#hero').getBoundingClientRect();
    const rInner = document.querySelector('.hero-inner').getBoundingClientRect();
    const r2 = document.querySelector('#bigo .topic-card').getBoundingClientRect();
    const rsb = document.querySelector('.sidebar').getBoundingClientRect();
    const sbEl = document.querySelector('.sidebar');
    const sbVisible = !!sbEl && getComputedStyle(sbEl).display !== 'none';
    const results = [];
    if (sbVisible) {
      // desktop: стеклянная панель hero == колонка карточек (по краям секции)
      results.push({ name: 'hero.l == card.l (левый край, ±2px)', ok: Math.abs(rHero.left - r2.left) <= 2, detail: rHero.left + ' vs ' + r2.left });
      results.push({ name: 'hero.r == card.r (правый край, ±2px)', ok: Math.abs(rHero.right - r2.right) <= 2, detail: rHero.right + ' vs ' + r2.right });
      results.push({ name: 'gap блок→sidebar == --gap', ok: Math.abs((r2.left - rsb.right) - gapPx) <= 1, detail: (r2.left - rsb.right).toFixed(1) + ' px' });
    } else {
      // mobile: панель hero шире колонок карточек на padding .container — сравниваем контентные блоки
      results.push({ name: 'hero-inner.l == card.l (mobile, ±2px)', ok: Math.abs(rInner.left - r2.left) <= 2, detail: rInner.left + ' vs ' + r2.left });
      results.push({ name: 'hero-inner.r == card.r (mobile, ±2px)', ok: Math.abs(rInner.right - r2.right) <= 2, detail: rInner.right + ' vs ' + r2.right });
      results.push({ name: 'gap блок→sidebar', ok: true, detail: 'SKIPPED (mobile: sidebar скрыт)' });
    }
    // вертикальный ритм во ВСЕХ секциях (только desktop-режим, где действует единый ритм)
    let badGaps = [];
    if (innerWidth >= 1201) {
      document.querySelectorAll('.main-content section > .container').forEach((c) => {
        const kids = Array.from(c.children);
        for (let i = 0; i < kids.length - 1; i++) {
          const a = kids[i].getBoundingClientRect(), b = kids[i + 1].getBoundingClientRect();
          const g = b.top - a.bottom;
          if (Math.abs(g - gapPx) > 1) badGaps.push(c.parentElement.id + ': ' + Math.round(g) + 'px');
        }
      });
    }
    results.push({ name: 'все вертикальные зазоры == --gap (' + gapPx + 'px)', ok: innerWidth < 1201 || badGaps.length === 0, detail: innerWidth < 1201 ? 'SKIPPED (mobile)' : (badGaps.slice(0, 8).join(', ') || 'нет отклонений') });
    // smoke: горизонтальный overflow?
    const sw = document.documentElement.scrollWidth;
    results.push({ name: 'без горизонтального overflow', ok: sw <= innerWidth + 1, detail: 'scrollWidth=' + sw + ', vw=' + innerWidth });
    // blur в фоне убран?
    const amb = getComputedStyle(document.querySelector('.ambient-bg')).filter;
    results.push({ name: '.ambient-bg без blur', ok: !/blur\\(/.test(amb), detail: amb });
    return { gapPx, results };
  })()`);
  console.log('gapVar px:', verify.gapPx);
  let allOk = true;
  for (const x of verify.results) {
    if (!x.ok) allOk = false;
    console.log(`${x.ok ? 'PASS' : 'FAIL'} | ${x.name} :: ${x.detail}`);
  }
  console.log(allOk ? '\n>>> ALL CHECKS PASSED' : '\n>>> ЕСТЬ ОТКЛОНЕНИЯ');

  cdp.close();
} catch (e) {
  console.error('FATAL:', e.message);
  exitCode = 2;
} finally {
  chrome.kill();
}
process.exit(exitCode);

