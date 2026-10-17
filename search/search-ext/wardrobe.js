// Character page: pager under the category links + bigger wardrobe pages ("Display Rows").
// Runs at document_start so the pager is fixed before anyone can click the old one.
// The site swaps #CustomizeCharacterContainer over ajax and keeps c / p / pick / q in the url, so everything
// here re-reads the url and re-applies whenever the page is swapped.
(() => {
  try { chrome.runtime.sendMessage('page-visit').catch(() => {}); } catch (e) {} // update check
  const DEFAULT = 2; // rows the site shows (4 items per row)
  const base = location.pathname;
  const cfg = { rows: DEFAULT, pager: true };
  let ready = false;
  let busy = false;
  let again = false;

  const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();

  const state = () => {
    const u = new URL(location.href).searchParams;
    return { c: u.get('c') || 'Hats', p: Math.max(1, parseInt(u.get('p'), 10) || 1), q: u.get('q') || '', pick: u.get('pick') || '' };
  };
  const listKey = s => `${s.c}|${s.q}|${s.pick}`;
  const pageUrl = (s, p) => `${base}?${qs({ c: s.c, p, q: s.q, pick: s.pick })}`;

  const pageInfo = doc => {
    const m = (doc.querySelector('.AttireChooser > .FooterPager')?.textContent || '').match(/Page\s+(\d+)\s+of\s+(\d+)/i);
    return m ? { n: +m[1], last: +m[2] } : { n: 1, last: 1 };
  };

  // wearing or removing changes what the wardrobe lists, so cached pages are tied to what is worn right now
  const wornSig = () =>
    [...document.querySelectorAll('.Accoutrements a[href*="remove="]')]
      .map(a => (a.getAttribute('href').match(/remove=(\d+)/) || [])[1])
      .filter(Boolean).sort().join(',');

  // ---- cache: site pages, in memory and in the tab's session storage ----

  const TTL = 2 * 60 * 1000;
  const PREFIX = 'ss_pg_';
  const mem = new Map();
  const known = new Map(); // list -> number of site pages

  const readCache = key => {
    let e = mem.get(key);
    if (!e) {
      try { e = JSON.parse(sessionStorage.getItem(PREFIX + key)); } catch (err) {}
    }
    return e && e.sig === wornSig() && Date.now() - e.at < TTL ? (mem.set(key, e), e) : null;
  };

  const writeCache = (key, e) => {
    mem.set(key, e);
    try {
      const keys = Object.keys(sessionStorage).filter(k => k.startsWith(PREFIX));
      if (keys.length > 60) keys.slice(0, keys.length - 40).forEach(k => sessionStorage.removeItem(k));
      sessionStorage.setItem(PREFIX + key, JSON.stringify(e));
    } catch (err) {}
  };

  // one site page: { cards: [html], n: page the site really returned, last: page count }, or null
  async function getPage(s, n) {
    const key = `${listKey(s)}|${n}`;
    const hit = readCache(key);
    if (hit) return hit;
    try {
      const sig = wornSig();
      const res = await fetch(`${base}?${qs({ c: s.c, p: n, q: s.q, pick: s.pick })}`, { credentials: 'same-origin' });
      if (!res.ok) return null;
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const { n: got, last } = pageInfo(doc);
      const e = {
        at: Date.now(), sig, n: got, last,
        cards: [...doc.querySelectorAll('.AttireChooser > .AttireOptions .Asset')].map(el => el.outerHTML),
      };
      writeCache(key, e);
      return e;
    } catch (err) {
      return null;
    }
  }

  // a whole page (k site pages) at once; pages past the end come back as the last page again, so they're dropped
  async function getBlock(s, p, k) {
    const nums = Array.from({ length: k }, (_, i) => (p - 1) * k + 1 + i);
    const got = await Promise.all(nums.map(n => getPage(s, n)));
    if (!got[0]) return null;
    known.set(listKey(s), got[0].last);
    return { last: got[0].last, pages: got.filter((g, i) => g && g.n === nums[i]) };
  }

  // ---- pager ----

  function fixPager() {
    const chooser = document.querySelector('.AttireChooser');
    const cats = chooser && chooser.querySelector(':scope > .AttireCategory');
    const pager = chooser && chooser.querySelector('.FooterPager');
    if (!cats || !pager) return;
    // wait until the parser is past the pager, so nothing gets appended to it after we change it
    if (!pager.dataset.ssSeen) {
      if (!pager.nextSibling && document.readyState === 'loading') return;
      pager.dataset.ssSeen = '1';
    }

    // goes inside the category block (in the gap under the links), so it can't crowd the site's search row
    if (cfg.pager && pager.parentNode !== cats) {
      pager.classList.add('ss-pager');
      cats.append(pager);
    }

    if (cfg.rows <= DEFAULT) return;
    const s = state();
    const k = cfg.rows / DEFAULT;
    const mine = `${cfg.rows}|${listKey(s)}|${s.p}`;
    if (pager.dataset.ssMine === mine) return;

    let last;
    if (!pager.dataset.ssMine) { // still the site's own pager
      const m = pager.textContent.match(/Page\s+\d+\s+of\s+(\d+)/i);
      if (!m) return;
      last = +m[1];
      known.set(listKey(s), last);
    } else {
      last = known.get(listKey(s));
      if (!last) return; // apply() fills this in
    }
    const total = Math.max(1, Math.ceil(last / k));
    if (s.p > total) { location.replace(pageUrl(s, total)); return; }
    const link = (to, html) => `<a href="${pageUrl(s, to)}">${html}</a>`;
    pager.innerHTML =
      (s.p > 1 ? link(s.p - 1, '<span class="NavigationIndicators">&lt;&lt;</span> Prev') + ' ' : '') +
      `<span>Page ${s.p} of ${total}</span> ` +
      (s.p < total ? link(s.p + 1, 'Next <span class="NavigationIndicators">&gt;&gt;</span>') : '');
    pager.dataset.ssMine = mine;
  }

  // ---- bigger pages ----

  const stockOptions = () =>
    document.querySelector('.AttireChooser > .AttireOptions:not(#ox-panel):not(#ss-panel)');

  // false when the page couldn't be built (so callers can fall back to a normal page load)
  async function apply() {
    if (!ready || cfg.rows <= DEFAULT) return true;
    const s = state();
    let options = stockOptions();
    if (!options) return true;
    // still streaming in: the parser would keep adding the site's own cards after ours (mixed/duplicated page)
    if (document.readyState === 'loading' && !options.nextElementSibling) return true;

    const k = cfg.rows / DEFAULT;
    const keyNow = () => { const t = state(); return `${cfg.rows}|${listKey(t)}|${t.p}|${wornSig()}`; };
    if (options.dataset.ssRows === keyNow()) return true;
    if (busy) { again = true; return true; }
    busy = true;
    let ok = true;
    try {
      const startKey = keyNow();
      if (options.dataset.ssRows) options.style.opacity = '0.55'; // old page still showing while the new one loads
      const block = await getBlock(s, s.p, k);
      options = stockOptions(); // the site may have swapped the page while we waited
      if (!block) { ok = false; return false; }
      if (!options || startKey !== keyNow()) return true; // moved on, the next pass handles it
      if (!block.pages.length) { ok = false; return false; }

      const seen = new Set();
      const tpl = document.createElement('template');
      tpl.innerHTML = block.pages.flatMap(g => g.cards).join('');
      const cards = [...tpl.content.children].filter(card => {
        const id = (card.querySelector('a[href*="wear="], a[href*="remove="]')?.getAttribute('href') || '').match(/(?:wear|remove)=(\d+)/)?.[1];
        if (!id) return true;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      const clear = options.querySelector(':scope > div[style*="clear"]');
      options.querySelectorAll(':scope > .Asset').forEach(n => n.remove());
      cards.forEach(card => {
        const el = document.importNode(card, true);
        // wearing/removing should land back on this page
        el.querySelectorAll('a[href*="wear="], a[href*="remove="]').forEach(a => {
          try {
            const u = new URL(a.getAttribute('href'), location.href);
            u.searchParams.set('p', s.p);
            a.setAttribute('href', u.pathname + u.search);
          } catch (e) {}
        });
        clear ? options.insertBefore(el, clear) : options.append(el);
      });
      options.dataset.ssRows = startKey;
      fixPager();

      // warm the next page so Next is instant
      const total = Math.max(1, Math.ceil(block.last / k));
      if (s.p < total) setTimeout(() => getBlock(s, s.p + 1, k), 400);
    } finally {
      busy = false;
      const o = stockOptions();
      if (o) o.style.opacity = '';
      if (again) { again = false; setTimeout(tick, 0); }
    }
    return ok;
  }

  function tick() {
    if (!ready) return Promise.resolve(true);
    fixPager();
    return apply();
  }

  new MutationObserver(() => { tick(); }).observe(document, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => { tick(); });

  // with bigger pages the site's own pager link would fetch one small page; build ours straight from the cache instead
  document.addEventListener('click', e => {
    if (!ready || cfg.rows <= DEFAULT || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const a = e.target.closest && e.target.closest('.AttireChooser .FooterPager a[href]');
    if (!a) return;
    let u;
    try { u = new URL(a.href, location.href); } catch (err) { return; }
    if (u.pathname !== base) return;
    e.preventDefault();
    e.stopPropagation();
    history.replaceState(null, '', u.pathname + u.search);
    fixPager();
    apply().then(ok => { if (ok === false) location.href = u.href; });
  }, true);

  try {
    chrome.storage.local.get(['rows', 'features']).then(r => {
      cfg.rows = +r.rows || DEFAULT;
      cfg.pager = !(r.features && r.features.pager === false);
      ready = true;
      tick();
    });
    chrome.storage.onChanged.addListener(ch => { if (ch.rows || ch.features) location.reload(); });
  } catch (e) {}
})();
