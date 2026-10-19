// iPhone-size (390x844) screenshots of the key pages in dark and light themes.
// Usage: start the server (local DB with example data), then: BASE_URL=http://localhost:3000 npm run screenshots
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OUT = path.join(__dirname, '..');
const ADMIN_PW = process.env.ADMIN_PASSWORD || fs.readFileSync(path.join(OUT, '.admin-password.local'), 'utf8').trim();
const ONLY = process.argv.slice(2);
const iphone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' };

async function ctx(browser, theme, login) {
  const c = await browser.newContext({ ...iphone, colorScheme: theme });
  await c.addInitScript(t => { try { localStorage.setItem('gamz-theme', t); } catch {} }, theme);
  if (login) {
    const r = await c.request.post(BASE + '/api/login', { data: login });
    if (!r.ok()) throw new Error('login failed for ' + login.username + ': ' + r.status());
    await c.request.put(BASE + '/api/me', { data: { theme } });
  }
  return c;
}
const shots = [
  // [name, who, hash, action]
  ['home', null, '#/'],
  ['tournaments', null, '#/tournaments'],
  ['bracket', null, '#/t/1?tab=bracket'],
  ['bracket-double', null, '#/t/6?tab=bracket', async p => { await p.$eval('.bracket-section:nth-of-type(2)', e => e.scrollIntoView({ block: 'start' })).catch(() => {}); await p.evaluate(() => scrollBy(0, -70)); }],
  ['league', null, '#/t/2?tab=table'],
  ['pubg-standings', null, '#/t/4?tab=standings'],
  ['leaderboard', null, '#/leaderboard'],
  ['leaderboard-pubg', null, '#/leaderboard?game=pubgm'],
  ['pairing', null, '#/pairing?demo=1'],
  ['profile', null, '#/p/14'],
  ['signup', null, '#/signup'],
  ['account', 'player', '#/me'],
  ['admin', 'admin', '#/admin'],
  ['admin-result', 'admin', '#/admin/t/1', async p => { await p.click('.list-row[data-mid]'); await p.waitForSelector('#rf'); await p.click('[data-st=hs][data-d="1"]'); await p.click('[data-st=hs][data-d="1"]'); await p.click('[data-st=as][data-d="1"]'); await p.click('[data-st=as][data-d="1"]'); await p.fill('[name=home_pens]', '4'); await p.fill('[name=away_pens]', '3'); }],
  ['admin-br-result', 'admin', '#/admin/t/4', async p => { await p.click('.list-row[data-mid]:not(:has(.btn:not(.primary)))'); await p.waitForSelector('#bf'); const rows = await p.$$('tr[data-pid]'); const demo = [[3, 6], [1, 9], [5, 2], [2, 7], [4, 4]]; for (let i = 0; i < demo.length; i++) { await rows[i].$eval('[name=pl]', (e, v) => { e.value = v; }, demo[i][0]); await rows[i].$eval('[name=k]', (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, demo[i][1]); } }],
  ['system', 'admin', '#/system'],
];
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const errors = [], saved = [];
  for (const theme of ['dark', 'light']) {
    const who = { null: await ctx(browser, theme), admin: await ctx(browser, theme, { username: process.env.ADMIN_USER || 'admin', password: ADMIN_PW }), player: await ctx(browser, theme, { username: 'example_player', password: 'example-player-pass' }) };
    for (const [name, user, hash, act] of shots) {
      if (ONLY.length && !ONLY.includes(name)) continue;
      const p = await who[user].newPage();
      p.on('pageerror', e => errors.push(`${name}/${theme}: ${e.message}`));
      await p.goto(BASE + '/' + hash); await p.waitForSelector('.view', { timeout: 10000 }); await p.waitForTimeout(700);
      if (act) { await act(p); await p.waitForTimeout(700); }
      const file = path.join(OUT, `screenshot-${name}-${theme}.png`); await p.screenshot({ path: file }); saved.push(path.basename(file));
      const wide = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      if (wide) errors.push(`${name}/${theme}: page wider than viewport`);
      await p.close();
    }
    for (const c of Object.values(who)) await c.close();
  }
  if (!ONLY.length || ONLY.includes('live')) {
    // Live-update check: a logged-out viewer sees the bracket change without reloading (SSE). The result is then cleared again.
    const viewer = await ctx(browser, 'dark'), adm = await ctx(browser, 'dark', { username: process.env.ADMIN_USER || 'admin', password: ADMIN_PW });
    const p = await viewer.newPage(); await p.goto(BASE + '/#/t/1?tab=bracket'); await p.waitForSelector('.match');
    const d = await (await adm.request.get(BASE + '/api/tournaments/1')).json(), m = d.matches.find(x => x.status === 'ready');
    const before = await p.$eval(`.match[data-mid="${m.id}"]`, e => e.textContent);
    await adm.request.post(BASE + `/api/matches/${m.id}/result`, { data: { home_score: 3, away_score: 1 } });
    await p.waitForSelector(`.match.flash[data-mid="${m.id}"]`, { timeout: 5000 });
    const after = await p.$eval(`.match[data-mid="${m.id}"]`, e => e.textContent);
    await adm.request.delete(BASE + `/api/matches/${m.id}/result`);
    console.log(`Live update (SSE) in browser: ${before !== after ? 'OK' : 'FAILED'} — "${before}" → "${after}" without reload (result cleared again)`);
    if (before === after) errors.push('live update did not change the bracket');
    await viewer.close(); await adm.close();
  }
  await browser.close();
  console.log('Saved', saved.length, 'screenshots:\n ' + saved.join('\n '));
  console.log(errors.length ? 'PROBLEMS:\n ' + errors.join('\n ') : 'No JS errors, no horizontal page overflow.');
  if (errors.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
