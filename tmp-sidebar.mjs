// Проверка распределения ссылок боковой панели по всей высоте:
// 1) база 1440×900 — 10 ссылок, равные зазоры;
// 2) добавление 11-й ссылки в DOM — зазоры пересчитываются, остаются равными (автоподвигание);
// 3) короткий viewport 1440×520 — overflow: ссылки жмутся с мин. gap 4px, без наложений, панель скроллится.
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
  const nav = document.querySelector('.sidebar-nav');
  const sidebar = document.getElementById('sidebar');
  const links = Array.from(nav.querySelectorAll(':scope > a.s-link'));
  const r = (el) => el.getBoundingClientRect();
  const rows = links.map((a, i) => ({ i: i + 1, top: +r(a).top.toFixed(2), bottom: +r(a).bottom.toFixed(2) }));
  const gaps = [];
  for (let i = 0; i < rows.length - 1; i++) gaps.push(+(rows[i + 1].top - rows[i].bottom).toFixed(2));
  return {
    count: rows.length,
    navTop: +r(nav).top.toFixed(1), navBottom: +r(nav).bottom.toFixed(1),
    sidebarTop: +r(sidebar).top.toFixed(1), sidebarBottom: +r(sidebar).bottom.toFixed(1),
    firstFromNavTop: +(rows[0].top - r(nav).top).toFixed(2),
    lastToNavBottom: +(r(nav).bottom - rows[rows.length - 1].bottom).toFixed(2),
    gaps, minGap: Math.min(...gaps), maxGap: Math.max(...gaps),
    scrollable: sidebar.scrollHeight > sidebar.clientHeight + 1,
  };
})()`;

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(os.tmpdir(), 'algo-cdp-sidebar-' + Date.now())}`,
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

  const m0 = await evalJs(cdp, MEASURE);
  console.log('BASE 1440x900 (10 ссылок):', JSON.stringify(m0));
  await shot('sidebar-base.png');

  // Добавляем 11-ю ссылку — проверяем автоподвигание без нарушения равных зазоров.
  await evalJs(cdp, `(() => {
    const nav = document.querySelector('.sidebar-nav');
    const last = nav.querySelector(':scope > a.s-link:last-of-type');
    const c = last.cloneNode(true);
    c.setAttribute('data-sec', 'test11');
    c.href = '#bigo';
    const name = c.querySelector('.s-name'); if (name) name.textContent = 'TEST-11 (автоподвигание)';
    nav.appendChild(c); return 'added';
  })()`);
  await sleep(200);
  const m1 = await evalJs(cdp, MEASURE);
  console.log('AFTER ADD (11 ссылок):', JSON.stringify(m1));
  await shot('sidebar-after-add.png');

  // Короткий viewport — overflow: минимальные зазоры, без наложений.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 520, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const m2 = await evalJs(cdp, MEASURE);
  console.log('SHORT 1440x520 (overflow):', JSON.stringify(m2));

  // Итоговые проверки.
  const eq = (m) => Math.max(...m.gaps) - Math.min(...m.gaps) <= 0.6;
  const noOverlap = (m) => m.minGap >= 3.4;
  console.log('CHECK base: equal gaps =', eq(m0), '; first/last flush to nav edges =',
    Math.abs(m0.firstFromNavTop) < 1 && Math.abs(m0.lastToNavBottom) < 1);
  console.log('CHECK after-add: equal gaps =', eq(m1), ', no overlap =', noOverlap(m1));
  console.log('CHECK short-viewport: no overlap =', noOverlap(m2), ', scrollable =', m2.scrollable, ', minGap =', m2.minGap);
} finally {
  chrome.kill();
}
