// CDP diagnostic: scroll-top button in light/dark themes (no deps)
import { spawn } from 'node:child_process';
const fs = await import('node:fs');
const PORT = 9351;
const URL_ = 'file:///C:/Users/Lep4i/Desktop/My%20GitHub/Algo%20%26%20Struct/index.html';
let seq = 0;

function launch() {
  const args = ['--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=C:/Users/Lep4i/AppData/Local/Temp/csc-st-' + Date.now(),
    '--no-first-run', 'about:blank'];
  let proc;
  try { proc = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', args); }
  catch { proc = spawn('"C:/Program Files/Google/Chrome/Application/chrome.exe"', args, { shell: true }); }
  let buf = ''; const onData = d => { buf += String(d); tryParse(); };
  function tryParse() {
    const i = buf.indexOf('\n'); if (i === -1) return;
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    let j; try { j = JSON.parse(line); } catch { return; }
    if (j.id === 1 && j.result?.webSocketDebuggerUrl) { wsUrl = j.result.webSocketDebuggerUrl; resolve(); }
  }
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', onData);
    setTimeout(() => reject(new Error('no target')), 8000);
  });
}

function send(ws, method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const h = ev => { const m = JSON.parse(ev.data);
      if (m.id === id) { ws.removeEventListener('message', h); m.error ? reject(new Error(m.message)) : resolve(m.result); } };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

const results = [];
function check(name, cond, info) { results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (info ? ' | ' + info : '')); }

async function main() {
  await launch();
  const ws = new WebSocket(wsUrl);
  await new Promise(r => { ws.onopen = r; });
  const navP = new Promise(r => ws.addEventListener('message', e => {
    if (JSON.parse(e.data).method === 'Page.loadEventFired') r(); }));
  await send(ws, 'Page.enable'); await send(ws, 'Runtime.enable');
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await send(ws, 'Page.navigate', { url: URL_ });
  await navP;
  fs.mkdirSync('C:/Users/Lep4i/Desktop/My GitHub/Algo & Struct/shots-st', { recursive: true });
  await new Promise(r => setTimeout(r, 600));

  const probe = `var b=document.getElementById('scrollTopBtn');b.classList.add('is-visible');var cs=getComputedStyle(b);var svg=b.querySelector('svg');var scs=getComputedStyle(svg);JSON.stringify({theme:document.documentElement.getAttribute('data-theme'),bg:(cs.backgroundImage||cs.backgroundColor),color:cs.color,border:cs.border,radius:cs.borderRadius,boxShadow:cs.boxShadow.slice(0,120),svgStroke:scs.stroke,visible:b.classList.contains('is-visible')})`;
  const light = JSON.parse((await send(ws, 'Runtime.evaluate', { expression: "(function(){window.scrollTo(0,1200);document.documentElement.setAttribute('data-theme','light');return " + probe + ';})()', returnByValue: true })).result.value);
  await new Promise(r => setTimeout(r, 300));
  fs.writeFileSync('C:/Users/Lep4i/Desktop/My GitHub/Algo & Struct/shots-st/light-full.png', Buffer.from((await send(ws, 'Page.captureScreenshot', { format: 'png' })).data, 'base64'));

  const dark = JSON.parse((await send(ws, 'Runtime.evaluate', { expression: "(function(){document.documentElement.setAttribute('data-theme','dark');return " + probe + ';})()', returnByValue: true })).result.value);
  await new Promise(r => setTimeout(r, 300));
  fs.writeFileSync('C:/Users/Lep4i/Desktop/My GitHub/Algo & Struct/shots-st/dark-full.png', Buffer.from((await send(ws, 'Page.captureScreenshot', { format: 'png' })).data, 'base64'));

  // chevron geometry symmetry (viewBox 0 0 24 24)
  const G = JSON.parse((await send(ws, 'Runtime.evaluate', { expression: "(function(){var p=document.querySelector('#scrollTopBtn polyline').getAttribute('points');var q=p.trim().split(/\\s+/).map(Number);return JSON.stringify({p:p,midX:(q[0]+q[2])/2,yTop:q[1],yEndA:q[3]})})()", returnByValue: true })).result.value);

  // favicon check (link present + SVG loads)
  const fav = JSON.parse((await send(ws, 'Runtime.evaluate', { expression: "(function(){var l=document.querySelector('link[rel=icon]');if(!l)return Promise.resolve(JSON.stringify({ok:false}));return new Promise(function(res){var img=new Image();img.onload=function(){res(JSON.stringify({ok:true,href:l.href}))};img.onerror=function(){res(JSON.stringify({ok:false}))};img.src=l.href;});})()", returnByValue: true, awaitPromise: true })).result.value);

  console.log('FAVICON:', fav.ok ? 'OK' : 'MISSING', fav.href || '');

  console.log('LIGHT:', light.theme, '|', (light.bg || '').slice(0, 90), '| color:', light.color, '| border:', light.border, '| svgStroke:', light.svgStroke);
  console.log('DARK :', dark.theme, '|', (dark.bg || '').slice(0, 90), '| color:', dark.color, '| border:', dark.border, '| svgStroke:', dark.svgStroke);

  check('light: visible class present', light.visible === true);
  check('light: ice-glass bg (semi-transparent white gradient)', /linear-gradient/.test(light.bg) && /rgba\(255,\s*255,\s*255,\s*0\.7\)/.test(light.bg), (light.bg || 'n/a').slice(0, 110));
  check('light: not solid blue anymore', !/3b82f6|2563eb/i.test(light.bg), (light.bg || 'n/a').slice(0, 110));
  check('light: dark-blue icon rgb(29,78,216) for contrast on glass', /rgb\(29,\s*78,\s*216\)/.test(light.color), light.color);
  check('dark: deep navy gradient bg intact (no regression)', /radial-gradient/.test(dark.bg) && /rgba\(37,\s*99,\s*235/.test(dark.bg), (dark.bg || 'n/a').slice(0, 110));
  check('dark: white icon', /rgb\(255,\s*255,\s*255\)/.test(dark.color) || /^#fff$/i.test(dark.color), dark.color);
  check('svg uses currentColor stroke', /currentcolor/i.test(light.svgStroke), light.svgStroke);
  check('chevron symmetric (midX=12)', Math.abs(G.midX - 12) < 0.01, 'points=' + G.p + ' midX=' + G.midX);

  ws.close();
  console.log(results.join('\n'));
  process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
}
main().catch(e => { console.error('FATAL:', e.message || e); process.exit(2); });
