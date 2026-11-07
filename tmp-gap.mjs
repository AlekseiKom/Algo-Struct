// ВРЕМЕННЫЙ диагностик v2: скриншоты границ секций и футера (CDP).
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { CDP, httpGet, waitForChrome, sleep } from './cdp-raw.mjs';

const CHROME = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const PORT = 9300 + Math.floor(Math.random() * 1000);
const PAGE = 'file:///' + path.join(process.cwd(), 'index.html').replace(/\\/g, '/').replace(/[^\x20-\x7e]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/ /g, '%20').replace(/&/g, '%26');

const evalJs = async (cdp, expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error('ошибка evaluate: ' + JSON.stringify(r.exceptionDetails));
  if ('value' in r.result || r.result.type === 'undefined') return r.result.value;
  throw new Error('evaluate без значения');
};

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(os.tmpdir(), 'algo-gap-diag-' + Date.now())}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1440,900', PAGE,
], { stdio: 'ignore' });

let exitCode = 1;
try {
  await waitForChrome(PORT);
  const list = JSON.parse((await httpGet(`http://127.0.0.1:${PORT}/json`)).body);
  const page = list.find((t) => t.type === 'page' && t.url.startsWith('file:///'));
  if (!page) throw new Error('no page target');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if ((await evalJs(cdp, 'document.readyState')) === 'complete') break;
    await sleep(250);
  }
  await evalJs(cdp, "window.scrollTo({top: document.body.scrollHeight, behavior:'instant'})");
  await sleep(400);
  await evalJs(cdp, "window.scrollTo({top: 0, behavior:'instant'})");
  await evalJs(cdp, "document.querySelectorAll('.rv').forEach(e => e.classList.add('vis'))");
  await sleep(900);

  const geo = JSON.parse(await evalJs(cdp, `JSON.stringify({
    pageH: document.body.scrollHeight,
    footerTop: Math.round(document.querySelector('footer').getBoundingClientRect().top + scrollY),
    heroBot: Math.round(document.getElementById('hero').getBoundingClientRect().bottom + scrollY)
  })`));
  console.log('GEO:', JSON.stringify(geo));

  const shotsDir = path.join(process.cwd(), 'shots');
  fs.mkdirSync(shotsDir, { recursive: true });

  async function shot(name, yTop) {
    await evalJs(cdp, 'window.scrollTo({top:' + Math.max(0, yTop) + ', behavior:"instant"})');
    await sleep(250);
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shotsDir, name + '.png'), Buffer.from(r.data, 'base64'));
    console.log('shot saved:', name + '.png (viewport top=' + Math.max(0, yTop) + ')');
  }

  // hero→bigo: центр границы ~398; bigo→arrays ~4379; arrays→recursion ~6256
  await shot('gap-hero-bigo', geo.heroBot - 450);
  await shot('gap-bigo-arrays', 3928);      // 4378 - 450
  await shot('gap-arrays-rec', 5806);       // 6256 - 450
  await shot('gap-footer-end', geo.pageH - 900);

  exitCode = 0;
} catch (e) {
  console.error('ERR:', e.message || e);
} finally {
  try { chrome.kill(); } catch {}
  process.exit(exitCode);
}

