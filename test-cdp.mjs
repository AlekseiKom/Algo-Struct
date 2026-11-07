// CDP smoke-test (без внешних зависимостей, raw WebSocket — см. cdp-raw.mjs):
// 1) sticky sidebar не едет со страницей; 2) hero = glass; 3) reveal: .rv виден без JS-задержки.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { CDP, httpGet, waitForChrome, sleep } from './cdp-raw.mjs';

const CHROME = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const PORT = 9300 + Math.floor(Math.random() * 1000); // уникальный порт на запуск — защита от зомби-Chrome
// file:// URL с кодированием пробелов и & (папка «Algo & Struct»)
const PAGE = 'file:///' + path.join(process.cwd(), 'index.html').replace(/\\/g, '/').replace(/[^\x20-\x7e]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/ /g, '%20').replace(/&/g, '%26');

// CDP-класс вынесен в ./cdp-raw.mjs (там же — фикс 8-байтной расширенной длины на офсете 2).

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

// evaluate с явной ошибкой: exceptionDetails в ответе = исключение внутри страницы
const evalJs = async (cdp, expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails)
    throw new Error('ошибка evaluate в странице: ' + JSON.stringify(r.exceptionDetails));
  if ('value' in r.result || r.result.type === 'undefined') return r.result.value;
  throw new Error('evaluate без значения: ' + JSON.stringify(r));
};

// Измерение sticky sidebar (position, top/bottom относительно viewport)
const SIDEBAR = `(() => {
    const el = document.querySelector('.sidebar');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { pos: getComputedStyle(el).position, top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), height: +r.height.toFixed(1) };
  })()`;

// Поиск самого глубокого скрытого .rv → его ИНДЕКС среди всех .rv + абсолютный верх (индекс стабилен:
// DOM не меняется во время теста, в отличие от подбора по «примерной позиции»)
const FIND_DEEP_RV = `(() => {
    const all = Array.from(document.querySelectorAll('.rv'));
    let idx = -1, absTop = 0;
    for (let i = 0; i < all.length; i++) {
      if (all[i].classList.contains('vis')) continue;
      const top = all[i].getBoundingClientRect().top + window.scrollY;
      if (top > 2 * innerHeight && top >= absTop) { absTop = top; idx = i; }
    }
    return idx === -1 ? null : { idx, absTop: Math.round(absTop) };
  })()`;

// Состояние конкретного .rv по индексу (класс vis + computed opacity + позиция в viewport)
const RV_STATE = (i) => `(() => {
    const e = document.querySelectorAll('.rv')[${i}];
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { vis: e.classList.contains('vis'), opacity: getComputedStyle(e).opacity, rTop: +r.top.toFixed(1), rBottom: +r.bottom.toFixed(1) };
  })()`;

// Прокрутить .rv с индексом i в центр viewport (instant) → текущий scrollY
const SCROLL_RV = (i) => `(() => {
    const e = document.querySelectorAll('.rv')[${i}];
    if (!e) return -1;
    e.scrollIntoView({ behavior: 'instant', block: 'center' });
    return Math.round(window.scrollY);
  })()`;

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

  // Релоад с уже включёнными Runtime/Page — чтобы поймать ВСЕ ошибки консоли/исключения
  // при загрузке страницы (события до подключения не ретранслируются)
  await cdp.send('Page.reload', { ignoreCache: true });

  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 15000) {
    const rs = await evalJs(cdp, 'document.readyState');
    if (rs === 'complete') { ready = true; break; }
    await sleep(250);
  }
  check('страница загружена (file://)', ready, `${Date.now() - t0} мс`);
  const jsClass = await evalJs(cdp, "document.documentElement.classList.contains('js')");
  check('html.js — ранний inline-скрипт отработал', jsClass === true);
  await sleep(600); // время на IO-колбэки первого кадра
  const VP_H = await evalJs(cdp, 'window.innerHeight'); // высота viewport (desktop 1440x900)

  // ---- 1. sticky sidebar: position + не съезжает со скроллом ----
  const s0 = await evalJs(cdp, SIDEBAR);
  check('S0: sidebar найден', !!s0);
  if (s0) {
    check('S0: position=sticky', s0.pos === 'sticky', s0.pos);
    // top должен быть ≈ header(66px) + gap(20px) = 86px на любом скролле
    check('S0: top≈86px (header+gap)', Math.abs(s0.top - 86) <= 5, `top=${s0.top}px`);
  }

  const scrolledTo = await evalJs(cdp, 'window.scrollTo({top:3000, behavior:"instant"}); window.scrollY');
  check('S1: прокрутка до 3000px', Math.abs(scrolledTo - 3000) <= 2, `scrollY=${scrolledTo}`);
  await sleep(500); // sticky пересчитывается синхронно, даём кадр на layout

  const s1 = await evalJs(cdp, SIDEBAR);
  if (s1) {
    check('S1: sidebar НЕ уехал вверх с контентом', Math.abs(s1.top - 86) <= 5, `top=${s1.top}px (было бы ≈${86 - 3000}px без sticky)`);
    check('S1: низ sidebar в пределах viewport', s1.bottom <= 902 && s1.bottom >= 700, `bottom=${s1.bottom}px`);
  }

  // ---- 2. hero = glass (тот же background/blur/радиус, что и .glass) ----
  const hero = await evalJs(cdp, `(() => {
    const el = document.getElementById('hero');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { cls: el.className, bgImage: cs.backgroundImage, bgColor: cs.backgroundColor, blur: (cs.backdropFilter || 'none'), radius: cs.borderRadius };
  })()`);
  check('H: #hero найден', !!hero);
  if (hero) {
    check('H: класс glass есть', /(^|\s)glass(\s|$)/.test(hero.cls), hero.cls);
    check('H: backdrop-filter — blur(...)', /blur\(/i.test(hero.blur), hero.blur);
    check('H: фон не прозрачный (градиент/цвет)', hero.bgImage !== 'none' || hero.bgColor !== 'rgba(0, 0, 0, 0)', `bg=${hero.bgColor}`);
    check('H: радиус = 26px (--radius-xl)', hero.radius === '26px', hero.radius);

    // сравнение с референсным .glass-блоком (не #hero)
    const ref = await evalJs(cdp, `(() => {
      const el = document.querySelector('.glass:not(#hero)');
      if (!el || el.getBoundingClientRect().width === 0) return null;
      const cs = getComputedStyle(el);
      return { bgImage: cs.backgroundImage, blur: (cs.backdropFilter || 'none'), radius: cs.borderRadius };
    })()`);
    if (ref) {
      check('H: фон и blur совпадают с другим .glass-блоком', hero.bgImage === ref.bgImage && hero.blur === ref.blur, `hero=${String(hero.bgImage).slice(0, 40)} / ref=${String(ref.bgImage).slice(0, 40)}`);
    } else {
      console.log('  [skip] референсный .glass-блок не найден');
    }
  }

  // ---- 3. reveal: без JS-задержки; глубокий .rv появляется при входе в viewport ----
  const rvTotal = await evalJs(cdp, "document.querySelectorAll('.rv').length");
  check('R0: есть .rv элементы', rvTotal > 10, `всего ${rvTotal}`);

  // IO живость на старте (scrollY=0): всё реально в effective root-прямоугольнике
  // (rootMargin -4% сверху/снизу) должно уже иметь .vis — observer обязан был сработать при observe().
  // Секция 1 прокрутила страницу до 3000px → возвращаемся наверх (instant: CSS scroll-behavior:smooth
  // иначе анимирует скролл, и через 900мс позиция ещё не точно 0) и ждём IO-колбэки.
  await evalJs(cdp, 'window.scrollTo({top: 0, left: 0, behavior: "instant"})');
  await sleep(900);
  const initRv = await evalJs(cdp, `(() => {
    let inView = 0, visInView = 0;
    for (const e of document.querySelectorAll('.rv')) {
      const r = e.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.top < innerHeight * 0.96 && r.bottom > innerHeight * 0.04) { inView++; if (e.classList.contains('vis')) visInView++; }
    }
    return { scrollY: Math.round(window.scrollY), inView, visInView };
  })()`);
  check(
    'R-init: reveal-наблюдатель жив (первый viewport получил .vis)',
    initRv.scrollY === 0 && (initRv.inView === 0 || initRv.visInView > 0),
    `scrollY=${initRv.scrollY}, inViewport=${initRv.inView}, с .vis=${initRv.visInView}`
  );

  const deep = await evalJs(cdp, FIND_DEEP_RV);
  check('R1: найдена глубокая скрытая .rv-карточка (>2 viewport)', !!deep, deep ? `idx=${deep.idx}, absTop=${deep.absTop}px` : 'не найдена');

  if (deep) {
    const sy = await evalJs(cdp, SCROLL_RV(deep.idx));
    check('R2: прокрутка к глубокому .rv выполнена', typeof sy === 'number' && sy > 0, `scrollY=${sy}`);
    const mid = await evalJs(cdp, RV_STATE(deep.idx));
    check(
      'R2b: глубокий .rv внутри viewport после скролла (блок center)',
      !!mid && mid.rTop >= -5 && mid.rBottom <= VP_H + 5,
      mid ? `rTop=${mid.rTop}, rBottom=${mid.rBottom}` : 'target не найден'
    );
    await sleep(900); // transition .rv = 0.6s

    const deepVisNow = await evalJs(cdp, RV_STATE(deep.idx));
    check('R3: глубокий .rv получил .vis после прокрутки', !!(deepVisNow && deepVisNow.vis), deepVisNow ? `rTop=${deepVisNow.rTop}` : 'target не найден');

    // Дожидаемся opacity=1 опросом (тяжёлая страница + headless: IO-колбэк и переход
    // могут завершиться позже, чем фиксированные 900мс) — максимум 5 секунд.
    let op = deepVisNow ? deepVisNow.opacity : null;
    let waitedMs = 900;
    while (op !== '1' && waitedMs < 5000) {
      await sleep(250);
      const s = await evalJs(cdp, RV_STATE(deep.idx));
      if (!s) break;
      op = s.opacity;
      waitedMs += 250;
    }
    check('R4: opacity=1 (не «застревает» на 0)', op === '1', `opacity=${op} через ${waitedMs}мс`);
  }

  // прогон до конца страницы — всё РЕАЛЬНО видимое .rv (внутри effective root) должно стать vis
  await evalJs(cdp, 'window.scrollTo({top:document.documentElement.scrollHeight, behavior:"instant"})');
  await sleep(900);
  const rEnd = await evalJs(cdp, `(() => {
    let hiddenVisible = 0;
    for (const e of document.querySelectorAll('.rv')) {
      const r = e.getBoundingClientRect();
      // «видим» = действительно в viewport: отрицательный r.top (блок выше) не считается
      if (r.width > 0 && r.bottom > innerHeight * 0.04 && r.top < innerHeight * 0.96 && !e.classList.contains('vis')) hiddenVisible++;
    }
    return { scrollY: Math.round(window.scrollY), docH: document.documentElement.scrollHeight, hiddenVisible };
  })()`);
  check(
    'R5: внизу страницы нет «скрытых» видимых .rv',
    rEnd.hiddenVisible === 0,
    `scrollY=${rEnd.scrollY}/${rEnd.docH}, скрытых-видимых=${rEnd.hiddenVisible}`
  );
  // ---- 4. горизонтальный overflow / layout sanity ----
  const ov = await evalJs(cdp, '(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))()');
  check('O: desktop без горизонтального скролла', ov.sw <= ov.cw + 1, `scrollW=${ov.sw}, clientW=${ov.cw}`);

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(400);
  const mob = await evalJs(cdp, `(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
    sidebarDisplay: getComputedStyle(document.querySelector('.sidebar')).display,
  }))()`);
  check('M: mobile без горизонтального скролла', mob.sw <= mob.cw + 1, `scrollW=${mob.sw}, clientW=${mob.cw}`);
  check('M: sidebar скрыт (≤1200px)', mob.sidebarDisplay === 'none', mob.sidebarDisplay);

  // ---- ошибки консоли/исключения (за всё время теста) ----
  const errCount = consoleErrors.length + exceptions.length;
  check('нет ошибок консоли и исключений', errCount === 0, errCount ? `${errCount}: ${[...consoleErrors, ...exceptions].join(' | ')}` : '0');

  cdp.close();
  exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.error('FATAL:', e.message);
  exitCode = 2;
} finally {
  chrome.kill();
}

console.log(failures === 0 ? '\nALL PASS' : `\nFAILURES: ${failures}`);
process.exit(exitCode);
