// CDP-проверка (без внешних зависимостей, raw WebSocket — см. cdp-raw.mjs):
// 1) hero сжат: весь блок в первом экране, контент ниже фиксированного хедера, якорь #hero → scrollY=0;
// 2) все 10 заголовков секций (.sec-head) = то же стекло, что у hero (радиус/blur/fond/padding идентичны);
// 3) структура заголовков единообразна (eye + h2.sec-title + p.sec-desc), мобильный viewport тоже в порядке;
// 4) ошибок консоли/исключений нет (тёмная и светлая тема).
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { CDP, httpGet, waitForChrome, sleep } from './cdp-raw.mjs';

const CHROME = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const PORT = 9300 + Math.floor(Math.random() * 1000); // уникальный порт на запуск — защита от зомби-Chrome
// file:// URL с кодированием пробелов и & (папка «Algo & Struct»)
const PAGE = 'file:///' + path.join(process.cwd(), 'index.html').replace(/\\/g, '/').replace(/[^\x20-\x7e]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/ /g, '%20').replace(/&/g, '%26');

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

const evalJs = async (cdp, expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error('ошибка evaluate в странице: ' + JSON.stringify(r.exceptionDetails));
  if ('value' in r.result || r.result.type === 'undefined') return r.result.value;
  throw new Error('evaluate без значения: ' + JSON.stringify(r));
};

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(os.tmpdir(), 'algo-cdp-test-' + Date.now())}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1440,900',
  PAGE,
], { stdio: 'ignore' });

let exitCode = 1;
try {
  const ver = await waitForChrome(PORT);
  console.log('browser:', ver.Browser);

  const list = JSON.parse((await httpGet(`http://127.0.0.1:${PORT}/json`)).body);
  const page = list.find((t) => t.type === 'page' && t.url.startsWith('file:///'));
  if (!page) throw new Error('не найден page-target с file:// URL');

  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect();

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
  // Релоад с уже включёнными Runtime/Page — чтобы поймать ВСЕ ошибки при загрузке
  await cdp.send('Page.reload', { ignoreCache: true });

  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 15000) {
    const rs = await evalJs(cdp, 'document.readyState');
    if (rs === 'complete') { ready = true; break; }
    await sleep(250);
  }
  check('страница загружена (file://)', ready, `${Date.now() - t0} мс`);

  // Снимки вычисленных стилей: hero + все .sec-head. Стекло задаётся через design-токен
  // --glass-card-blur (dark: blur(20px) saturate(160%)), поэтому сравниваем блоки между собой,
  // а не с хардкодом px — в светлой теме значения другие по определению токенов.
  const SHOT = `(() => {
    const grab = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { radius: cs.borderRadius, blur: cs.backdropFilter, bgImg: (cs.backgroundImage || '').slice(0, 48), padT: cs.paddingTop, padB: cs.paddingBottom, padL: cs.paddingLeft, padR: cs.paddingRight };
    };
    const hero = document.getElementById('hero');
    const hr = hero ? hero.getBoundingClientRect() : null;
    const heads = Array.from(document.querySelectorAll('.sec-head')).map((el) => {
      const s = grab(el);
      s.glass = el.classList.contains('glass');
      s.hasEye = !!el.querySelector('.sec-eye');
      s.hasTitle = !!el.querySelector('h2.sec-title');
      s.hasDesc = !!el.querySelector('p.sec-desc');
      return s;
    });
    const inner = document.querySelector('#hero .hero-inner');
    return {
      hero: grab(hero),
      heroTop: hr ? +hr.top.toFixed(1) : null,
      heroHeight: hr ? +hr.height.toFixed(1) : null,
      innerTop: inner ? +inner.getBoundingClientRect().top.toFixed(1) : null,
      headerH: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 66,
      scrollY: Math.round(window.scrollY),
      vpH: window.innerHeight,
      heads,
    };
  })()`;

  // ── HERO: сжатость и якорь под фиксированным хедером ───────────────
  const S0 = await evalJs(cdp, SHOT);
  console.log(`\nviewport: 1440x${S0.vpH}, header-h=${S0.headerH}px`);

  check('H0. один #hero с классом glass', !!S0.hero && (await evalJs(cdp, "document.getElementById('hero').classList.contains('glass')")));
  check('H1. hero: radius-xl = 26px', S0.hero.radius === '26px', `radius=${S0.hero.radius}`);
  const allBlurSame = S0.heads.every((h) => h && h.blur === S0.hero.blur);
  check('H2. hero и все .sec-head — ОДИН backdrop-filter (стекло)', /blur\(\d+px\)/.test(S0.hero.blur || '') && allBlurSame, `blur=${S0.hero.blur}`);
  const bgOk = S0.hero.bgImg && S0.hero.bgImg !== '' && S0.heads.every((h) => h && h.bgImg === S0.hero.bgImg);
  check('H3. hero и все .sec-head — идентичный непрозрачный фон', !!bgOk, `bg=${S0.hero.bgImg}`);

  // Критерий «не здоровый»: весь блок hero в первом экране (нижняя граница = docTop + height ≤ viewport)
  const heroBottom = S0.heroTop + S0.heroHeight;
  check('H4. весь #hero помещается в первый экран', heroBottom <= S0.vpH + 1, `top=${S0.heroTop}px, h=${S0.heroHeight}px, bottom=${heroBottom.toFixed(1)}px / ${S0.vpH}px (${Math.round((S0.heroHeight / S0.vpH) * 100)}% высоты экрана)`);

  // Якорь #hero: он ПЕРВЫЙ блок в потоке — скролл клампится в doc-top (scrollY=0),
  // верх стекла остаётся под полупрозрачным хедером по дизайну; контент обязан быть ниже хедера.
  // Для детерминизации отключаем плавный скролл на время проверки якорей.
  await evalJs(cdp, 'document.documentElement.style.scrollBehavior = "auto"');
  await evalJs(cdp, 'window.scrollTo(0, document.body.scrollHeight / 2)');
  await sleep(150);
  await evalJs(cdp, "document.getElementById('hero').scrollIntoView({ block: 'start' })");
  await sleep(250);
  const anchor = await evalJs(cdp, 'Math.round(window.scrollY)');
  check('H5. якорь #hero → scrollY=0 (первый блок, кламп в doc-top)', anchor === 0, `scrollY=${anchor}`);

  const S1 = await evalJs(cdp, SHOT);
  check('H6. контент hero (.hero-inner) ниже хедера при scrollY=0', S1.innerTop > S1.headerH, `innerTop=${S1.innerTop}px vs header=${S1.headerH}px`);
  await evalJs(cdp, 'window.scrollTo(0, 0)');

  // ── .sec-head: единообразие стекла и структуры (десктоп) ─────────────
  const heads = S0.heads;
  check('G0. найдено ровно 10 блоков .sec-head, все с классом glass', heads.length === 10 && heads.every((h) => h.glass), `найдено ${heads.length}`);

  const ref = heads[0] || {};
  check('G1. одинаковый border-radius у всех заголовков (и = hero)', heads.length > 0 && heads.every((h) => h.radius === ref.radius && h.radius === S0.hero.radius), `radius=${ref.radius}`);
  check('G2. одинаковый backdrop-filter у всех заголовков', heads.length > 0 && heads.every((h) => h.blur === ref.blur && /blur\(\d+px\)/.test(h.blur)), `blur=${ref.blur}`);
  check('G3. одинаковый фон у всех заголовков', heads.length > 0 && heads.every((h) => h.bgImg === ref.bgImg), `bg=${(ref.bgImg || '').slice(0, 40)}...`);

  const padKey = (h) => [h.padT, h.padB, h.padL, h.padR].join('|');
  check('G4. одинаковый padding у всех заголовков', heads.length > 0 && heads.every((h) => padKey(h) === padKey(ref)), `padding=${ref.padT}/${ref.padR}/${ref.padB}/${ref.padL}`);

  check('G5. структура каждого: .sec-eye + h2.sec-title + p.sec-desc (10/10)', heads.length > 0 && heads.every((h) => h.hasEye && h.hasTitle && h.hasDesc),
    `без desc: ${heads.filter((h) => !h.hasDesc).length}, без eye: ${heads.filter((h) => !h.hasEye).length}`);

  // ── Светлая тема: стекло адаптируется по design-токенам, но остаётся единообразным ─
  await evalJs(cdp, "document.documentElement.dataset.theme = 'light'");
  await sleep(400);
  const SL = await evalJs(cdp, SHOT);
  const lightUniform = SL.heads.length === 10 && SL.heads.every((h) => h.blur === SL.hero.blur && h.bgImg === SL.hero.bgImg && /blur\(\d+px\)/.test(h.blur));
  check('G6. светлая тема: hero и все заголовки — единое стекло (токены [data-theme=light])', lightUniform, `blur=${SL.hero.blur}, bg=${(SL.hero.bgImg || '').slice(0, 40)}...`);
  await evalJs(cdp, "document.documentElement.dataset.theme = 'dark'");

  // ── Мобильный viewport (390x844): hero в экране, заголовки единообразны между собой ─
  await evalJs(cdp, 'window.scrollTo(0, 0)');
  await sleep(150);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(500);
  const SM = await evalJs(cdp, SHOT);
  check('M1. мобильный: весь #hero в первом экране', (SM.heroTop + SM.heroHeight) <= SM.vpH + 1, `top=${SM.heroTop}px, h=${SM.heroHeight}px / ${SM.vpH}px`);
  const mRef = SM.heads[0] || {};
  check('M2. мобильный: padding единообразен у всех заголовков', SM.heads.length === 10 && SM.heads.every((h) => padKey(h) === padKey(mRef)), `padding=${mRef.padT}/${mRef.padR}`);
  check('M3. мобильный: стекло и структура целы (blur = hero)', SM.heads.length === 10 && SM.heads.every((h) => h.glass && h.hasEye && h.hasTitle && h.hasDesc && h.blur === SM.hero.blur));
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  // ── Ошибки консоли и исключения (за все проверки, включая светлую тему/эмуляцию) ─
  check('C1. нет console.error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  check('C2. нет исключений в странице', exceptions.length === 0, exceptions.slice(0, 3).join(' | '));

  exitCode = failures ? 1 : 0;
  console.log(`\n${failures ? `FAIL: ${failures} провалов` : 'ALL PASS'} (exit=${exitCode})`);
} catch (e) {
  console.error('\nОШИБКА ТЕСТА:', e.message || e);
  exitCode = 1;
} finally {
  chrome.kill('SIGKILL');
  setTimeout(() => process.exit(exitCode), 200).unref();
}

