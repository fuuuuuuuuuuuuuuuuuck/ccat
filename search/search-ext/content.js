(() => {
  // the site now has its own wardrobe search (q= in the url), which this one clashes with, so it stays off
  const SEARCH_BROKEN = true;
  if (SEARCH_BROKEN) return;

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const base = location.pathname;
  const TTL = 30 * 60 * 1000;
  const MAX_SHOWN = 120;
  let rowsPerPage = 2;
  chrome.storage.local.get('rows').then(r => { rowsPerPage = +r.rows || 2; }).catch(() => {});
  const hit = url => fetch(url, { credentials: 'same-origin' });
  const qs = o => new URLSearchParams(o).toString();

  const getUid = () =>
    (document.querySelector('a[href*="Friends.aspx?UserID="]')?.href.match(/UserID=(\d+)/) || [])[1] ||
    (document.querySelector('.CharacterViewer img[src*="Avatar"]')?.src.match(/userId=(\d+)/) || [])[1] ||
    'me';
  const cacheKey = () => 'search_index_' + getUid();

  const readWorn = () =>
    new Set(
      [...document.querySelectorAll('.Accoutrements a[href*="remove="]')]
        .map(a => (a.getAttribute('href').match(/remove=(\d+)/) || [])[1])
        .filter(Boolean)
    );

  // worn items are listed under Currently Wearing, not in the wardrobe categories, so they never get indexed
  const wornItems = () =>
    [...document.querySelectorAll('.Accoutrements .Asset')]
      .map(el => {
        const id = (el.querySelector('a[href*="remove="]')?.getAttribute('href') || '').match(/remove=(\d+)/)?.[1];
        if (!id) return null;
        const name = el.querySelector('.AssetName')?.textContent.trim() || id;
        const creator = el.querySelector('.AssetCreator .Detail')?.textContent.trim() || '';
        return {
          id, c: 'Hats', label: 'Worn', p: 1, name, creator,
          thumb: el.querySelector('img')?.getAttribute('src') || '',
          hay: `${name} ${creator} worn`.toLowerCase(),
        };
      })
      .filter(Boolean);

  // ---- indexing every category ----

  const categories = () => {
    const seen = new Set();
    return [...document.querySelectorAll('.AttireChooser .AttireCategory a[href*="c="]')]
      .map(a => {
        let c = null;
        try { c = new URL(a.href, location.href).searchParams.get('c'); } catch (e) {}
        return c && { c, label: a.textContent.trim() || c };
      })
      .filter(x => x && !seen.has(x.c) && seen.add(x.c));
  };

  async function fetchPage(c, label, p) {
    try {
      const res = await hit(`${base}?${qs({ c, p })}`);
      if (!res.ok) return { items: [], pages: 1 };
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const items = [...doc.querySelectorAll('.AttireChooser > .AttireOptions .Asset')]
        .map(el => {
          const href = el.querySelector('a[href*="wear="], a[href*="remove="]')?.getAttribute('href') || '';
          const id = (href.match(/(?:wear|remove)=(\d+)/) || [])[1];
          if (!id) return null;
          return {
            id,
            c,
            label,
            p,
            name: el.querySelector('.AssetName')?.textContent.trim() || el.querySelector('img')?.alt || id,
            creator: el.querySelector('.AssetCreator .Detail')?.textContent.trim() || '',
            thumb: el.querySelector('img')?.getAttribute('src') || '',
          };
        })
        .filter(Boolean);
      const m = (doc.querySelector('.AttireChooser > .FooterPager')?.textContent || '').match(/Page\s+\d+\s+of\s+(\d+)/i);
      return { items, pages: m ? Math.min(+m[1], 200) : 1 };
    } catch (e) {
      return { items: [], pages: 1 };
    }
  }

  async function buildIndex(onProgress) {
    const cats = categories();
    const out = new Map();
    let done = 0;
    const queue = [...cats];

    async function worker() {
      while (queue.length) {
        const { c, label } = queue.shift();
        const first = await fetchPage(c, label, 1);
        first.items.forEach(i => out.set(i.c + ':' + i.id, i));
        for (let p = 2; p <= first.pages; p++) {
          (await fetchPage(c, label, p)).items.forEach(i => out.set(i.c + ':' + i.id, i));
        }
        onProgress(`indexing… ${++done}/${cats.length} (${label})`);
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker));

    const items = [...out.values()];
    try { await chrome.storage.local.set({ [cacheKey()]: { at: Date.now(), items } }); } catch (e) {}
    return items;
  }

  let index = null; // { at, items }
  const prep = items => items.forEach(i => { i.hay = `${i.name} ${i.creator} ${i.label}`.toLowerCase(); });

  async function loadIndex(force, onProgress) {
    if (!force && index && Date.now() - index.at < TTL) return index;
    if (!force) {
      try {
        const saved = (await chrome.storage.local.get(cacheKey()))[cacheKey()];
        if (saved && Date.now() - saved.at < TTL) {
          prep(saved.items);
          return (index = saved);
        }
      } catch (e) {}
    }
    onProgress('indexing…');
    const items = await buildIndex(onProgress);
    prep(items);
    return (index = { at: Date.now(), items });
  }

  // ---- ui (nodes are created once and re-attached whenever the site rebuilds the page) ----

  const input = document.createElement('input');
  input.id = 'ss-input';
  input.type = 'text';
  input.placeholder = 'search wardrobe';
  input.autocomplete = 'off';
  input.spellcheck = false;

  const panel = document.createElement('div');
  panel.id = 'ss-panel';
  panel.className = 'AttireOptions';
  panel.style.display = 'none';
  panel.innerHTML = '<div class="ss-status"></div><div style="clear:both;"></div>';
  const statusEl = panel.querySelector('.ss-status');
  const setStatus = html => { statusEl.innerHTML = html; };

  let saved = null; // what we hid when opening, so it can be restored (works alongside other tools that swap this area)

  function showPanel() {
    const chooser = panel.parentNode;
    if (!saved && chooser) {
      saved = [...chooser.children]
        .filter(el => el !== panel && el.matches('.AttireOptions, .FooterPager'))
        .map(el => [el, el.style.display]);
      saved.forEach(([el]) => { el.style.display = 'none'; });
    }
    panel.style.display = '';
  }

  function hidePanel() {
    panel.style.display = 'none';
    if (saved) {
      saved.forEach(([el, d]) => { el.style.display = d; });
      saved = null;
    }
  }

  function card(i, worn) {
    const act = worn ? 'remove' : 'wear';
    const href = `${base}?${qs({ c: i.c, p: Math.ceil(i.p / (rowsPerPage / 2)), [act]: i.id })}`;
    return `
      <div class="Asset ss-card">
        <div class="AssetThumbnail">
          <a href="/Item.aspx?ID=${i.id}" title="${esc(i.name)}" style="display:inline-block;cursor:pointer;"><img src="${esc(i.thumb)}" width="110" height="110" border="0" alt="${esc(i.name)}" /></a>
          <div class="ss-tag"><a data-href="${esc(href)}">[ ${act} ]</a></div>
        </div>
        <div class="AssetDetails">
          <div class="AssetName"><a href="/Item.aspx?ID=${i.id}">${esc(i.name)}</a></div>
          <div class="AssetCreator"><span class="Label">Type:</span> <span class="Detail">${esc(i.label)}</span></div>
          ${i.creator ? `<div class="AssetCreator"><span class="Label">Creator:</span> <span class="Detail">${esc(i.creator)}</span></div>` : ''}
        </div>
      </div>`;
  }

  const score = (i, q) => {
    const n = i.name.toLowerCase();
    return n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : 3;
  };

  let token = 0;
  async function run(force) {
    const q = input.value.trim().toLowerCase();
    const mine = ++token;
    if (!q) { hidePanel(); return; }
    showPanel();
    panel.querySelectorAll('.ss-card').forEach(n => n.remove());

    let idx;
    try { idx = await loadIndex(!!force, t => { if (mine === token) setStatus(esc(t)); }); }
    catch (e) { setStatus('search failed: ' + esc(e.message)); return; }
    if (mine !== token) return;

    const terms = q.split(/\s+/);
    const have = new Set(idx.items.map(i => i.id));
    const all = idx.items.concat(wornItems().filter(i => !have.has(i.id)));
    const hits = all
      .filter(i => terms.every(t => i.hay.includes(t)))
      .sort((a, b) => score(a, q) - score(b, q) || a.name.localeCompare(b.name));

    panel.querySelectorAll('.ss-card').forEach(n => n.remove());
    const worn = readWorn();
    statusEl.nextElementSibling.insertAdjacentHTML('beforebegin', hits.slice(0, MAX_SHOWN).map(i => card(i, worn.has(i.id))).join(''));
    setStatus(
      `${hits.length} result${hits.length === 1 ? '' : 's'} for "${esc(input.value.trim())}"` +
      (hits.length > MAX_SHOWN ? ` (showing ${MAX_SHOWN})` : '') +
      `<br />${all.length} items indexed<br /><a data-act="refresh">refresh</a>`
    );
  }

  function mount() {
    const chooser = document.querySelector('.AttireChooser');
    const head = chooser && chooser.querySelector(':scope > h4');
    if (!head) return;
    let changed = false;

    // pager goes up under the category links instead of below the items
    const cats = chooser.querySelector(':scope > .AttireCategory');
    const pager = chooser.querySelector(':scope > .FooterPager');
    if (cats && pager && pager.previousElementSibling !== cats) {
      pager.classList.add('ss-pager');
      cats.after(pager);
    }

    if (input.parentNode !== head) { head.classList.add('ss-host'); head.append(input); changed = true; }
    if (panel.parentNode !== chooser) {
      const options = chooser.querySelector(':scope > .AttireOptions:not(#ss-panel)');
      (options || head).after(panel);
      changed = true;
    }
    if (!changed) return;

    // site rebuilt the wardrobe: the old hidden/shown state is gone, start clean and redo the search if there is one
    saved = null;
    panel.style.display = 'none';
    if (input.value.trim()) run();
  }

  let timer = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => run(), 180);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') e.preventDefault(); // it sits inside the page's form
    if (e.key === 'Escape') { input.value = ''; run(); }
  });

  panel.addEventListener('click', e => {
    const refresh = e.target.closest('[data-act="refresh"]');
    if (refresh) { e.preventDefault(); run(true); return; }

    const a = e.target.closest('[data-href]');
    if (!a) return;
    e.preventDefault();
    panel.classList.add('ss-busy');
    hit(a.dataset.href).finally(() => location.reload());
  });

  let mountTimer = 0;
  new MutationObserver(() => {
    clearTimeout(mountTimer);
    mountTimer = setTimeout(mount, 0);
  }).observe(document, { childList: true, subtree: true });

  mount();
})();
