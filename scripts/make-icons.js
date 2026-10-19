// Renders the gamz app icons (PWA + iPhone home screen) with headless Chrome. Run: npm run icons
const { chromium } = require('playwright-core');
const path = require('path');
const html = (size, pad) => `<html><body style="margin:0;background:#07060d">
<div style="width:${size}px;height:${size}px;position:relative;overflow:hidden;background:radial-gradient(circle at 25% 20%, #3b2a7a 0%, #110d24 55%, #07060d 100%)">
  <div style="position:absolute;width:${size * .8}px;height:${size * .8}px;left:${size * .35}px;top:${size * .4}px;border-radius:50%;background:rgba(96,165,250,.35);filter:blur(${size * .12}px)"></div>
  <div style="position:absolute;width:${size * .7}px;height:${size * .7}px;left:${-size * .15}px;top:${-size * .1}px;border-radius:50%;background:rgba(139,92,246,.45);filter:blur(${size * .12}px)"></div>
  <svg viewBox="0 0 100 100" style="position:absolute;inset:${pad}px;width:${size - 2 * pad}px;height:${size - 2 * pad}px">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c4b5fd"/><stop offset="1" stop-color="#93c5fd"/></linearGradient></defs>
    <circle cx="50" cy="50" r="30" fill="none" stroke="url(#g)" stroke-width="9" stroke-dasharray="150 40" stroke-linecap="round" transform="rotate(-35 50 50)"/>
    <circle cx="50" cy="50" r="9" fill="url(#g)"/>
  </svg>
</div></body></html>`;
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const [name, size, pad] of [['icon-192.png', 192, 30], ['icon-512.png', 512, 80], ['apple-touch-icon.png', 180, 28], ['icon-512-maskable.png', 512, 130]]) {
    const p = await b.newPage({ viewport: { width: size, height: size } });
    await p.setContent(html(size, pad)); await p.screenshot({ path: path.join(__dirname, '../public/icons', name) }); await p.close();
  }
  await b.close(); console.log('icons written to public/icons');
})().catch(e => { console.error(e); process.exit(1); });
