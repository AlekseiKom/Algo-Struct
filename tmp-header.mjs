// Проверка хедера (десктоп):
// 1) бургер-меню скрыт на десктопе (≥1201px);
// 2) строка хедера выровнена по основным блокам .app-layout: логотип = левый край боковой панели,
//    кластер кнопок = правый край контента; не шире «боковая панель + блоки»;
// 3) планшет 1000px (панель скрыта): бургер виден.
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

const MEASURE = `(() => {
  const rect = (sel) => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect() : null; };
  const burger = document.getElementById('burgerBtn');
  const hdr = rect('.hdr-inner'), logo = rect('.logo'), actions = rect('.hdr-actions');
  const side = rect('#sidebar'), main = rect('#mainContent');
  // все контентные блоки (прямые дети .container в каждой секции) + разделители между секциями
  const units = [];
  document.querySelectorAll('#mainContent > section').forEach((s) => {
    const c = s.querySelector(':scope > .container');
    if (!c) return;
    Array.from(c.children).forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.width >= 1 && b.height >= 1) units.push({ cls: String(el.className || '').slice(0, 24), top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), left: +b.left.toFixed(1), right: +b.right.toFixed(1) });
    });
  });
  const dividers = Array.from(document.querySelectorAll('#mainContent > .divider')).map((d) => { const b = d.getBoundingClientRect(); return { top: +b.top.toFixed(1), left: +b.left.toFixed(1), right: +b.right.toFixed(1) }; });
  return {
    vw: innerWidth,
    burgerDisplay: burger ? getComputedStyle(burger).display : 'missing',
    hdrLeft: +(hdr && hdr.left).toFixed(1), hdrRight: +(hdr && hdr.right).toFixed(1),
    logoLeft: +(logo && logo.left).toFixed(1), sideLeft: +(side && side.left).toFixed(1),
    actionsRight: +(actions && actions.right).toFixed(1), mainRight: +(main && main.right).toFixed(1),
    units, dividers,
  };
})()`;

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(os.tmpdir(), 'algo-cdp-header-' + Date.now())}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1440,900', PAGE,
], { stdio: 'ignore' });

const checks = [];
try {
  await waitForChrome(PORT);
  const list = JSON.parse((await httpGet(`http://127.0.0.1:${PORT}/json`)).body);
  const page = list.find((t) => t.type === 'page' && t.url.startsWith('file:///'));
  if (!page) throw new Error('не найден page-target с file:// URL');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if ((await evalJs(cdp, 'document.readyState')) === 'complete') break;
    await sleep(250);
  }
  // Замораживаем reveal-анимации — статичная верстка для замеров.
  await evalJs(cdp, `(() => {
    const st = document.createElement('style');
    st.textContent = '*{transition:none !important;animation:none !important} .rv{opacity:1 !important;transform:none !important}';
    document.head.appendChild(st); return 'ok';
  })()`);
  await sleep(300);

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
  };
  const alignOk = (m) => Math.abs(m.logoLeft - m.sideLeft) <= 1 && Math.abs(m.actionsRight - m.mainRight) <= 1;

  // ── Десктоп 1440×900 ──
  const d = await evalJs(cdp, MEASURE);
  console.log('DESKTOP 1440x900:', JSON.stringify(d));
  checks.push(['burger hidden (display:none)', d.burgerDisplay === 'none']);
  checks.push(['logo.left == sidebar.left', alignOk(d)]);
  // видимые элементы хедера не шире диапазона «боковая панель + блоки»
  const visibleInBlocks = (m) => m.logoLeft >= m.sideLeft - 1 && m.actionsRight <= m.mainRight + 1;
  checks.push(['visible header elements within blocks range', visibleInBlocks(d)]);
  await shot('header-desktop.png');

  // ── Широкий экран 1920×950 — layout центрирован, выравнивание должно сохраниться ──
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 950, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const w = await evalJs(cdp, MEASURE);
  console.log('WIDE 1920x950:', JSON.stringify(w));
  checks.push(['wide: burger hidden + edges aligned', w.burgerDisplay === 'none' && alignOk(w) && visibleInBlocks(w)]);

  // ── Планшет 1000×800 (боковая панель скрыта) — бургер должен появиться ──
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const t = await evalJs(cdp, MEASURE);
  console.log('TABLET 1000x800:', JSON.stringify(t));
  checks.push(['tablet: burger visible (display:flex)', t.burgerDisplay === 'flex']);
  await shot('header-tablet.png');

  // ── Планшет в портрете 768×1024 ──
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 768, height: 1024, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const tp = await evalJs(cdp, MEASURE);
  console.log('TABLET-PORTRAIT 768x1024:', JSON.stringify(tp));

  // ── Мобильный 375×800 (смартфон) ──
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  const mb = await evalJs(cdp, MEASURE);
  console.log('MOBILE 375x800:', JSON.stringify(mb));

  // Выравнивание хедера по краям контентных блоков (не зависит от ширины: логотип = левый край, кнопки = правый край)
  const edgeAlign = (m) => {
    if (!m.units.length) return false;
    const minL = Math.min(...m.units.map((u) => u.left));
    const maxR = Math.max(...m.units.map((u) => u.right));
    return Math.abs(m.logoLeft - minL) <= 1 && Math.abs(m.actionsRight - maxR) <= 1;
  };
  checks.push(['tablet-portrait: burger visible + edges aligned', tp.burgerDisplay === 'flex' && edgeAlign(tp)]);
  checks.push(['mobile: burger visible + edges aligned', mb.burgerDisplay === 'flex' && edgeAlign(mb)]);
  await shot('header-mobile.png');

  let ok = true;
  for (const [name, pass] of checks) { if (!pass) ok = false; console.log('CHECK ' + name + ' =', pass); }
  console.log(ok ? 'ALL PASS' : 'FAIL');
} finally {
  chrome.kill();
}