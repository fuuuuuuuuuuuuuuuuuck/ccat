(() => {
  try { chrome.runtime.sendMessage('page-visit').catch(() => {}); } catch (e) {} // update check
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const base = location.pathname;
  const hit = url => fetch(url, { credentials: 'same-origin' });

  // the avatar img disappears while the site is redrawing it, so never depend on it
  const findAvatar = () =>
    document.getElementById('ctl00_cphRoblox_AvatarImage') || document.querySelector('.CharacterViewer img[src*="Avatar"]');
  const getUid = () =>
    (document.querySelector('a[href*="Friends.aspx?UserID="]')?.href.match(/UserID=(\d+)/) || [])[1] ||
    (findAvatar()?.src.match(/userId=(\d+)/) || [])[1] ||
    'me';

  const store = {
    get: async () => { const k = 'outfits_' + getUid(); return (await chrome.storage.local.get(k))[k] || []; },
    set: list => chrome.storage.local.set({ ['outfits_' + getUid()]: list }),
  };

  // ---- reading the page ----

  const readWorn = (doc = document) =>
    [...doc.querySelectorAll('.Accoutrements .Asset')]
      .map(el => {
        const href = el.querySelector('a[href*="remove="]')?.getAttribute('href') || '';
        const m = href.match(/remove=(\d+)/);
        return m && { id: m[1], name: el.querySelector('.AssetName')?.textContent.trim() || m[1] };
      })
      .filter(Boolean);

  const readColors = () =>
    Object.fromEntries(
      [...document.querySelectorAll('.ColorChooserFrame a[title]')].map(a => [a.title, getComputedStyle(a).backgroundColor])
    );

  async function grabImage() {
    const avatar = findAvatar();
    if (!avatar) throw new Error('avatar is still redrawing, try again in a sec');
    const res = await fetch(avatar.src, { credentials: 'same-origin', cache: 'reload' });
    if (!res.ok) throw new Error('avatar fetch ' + res.status);
    const blob = await res.blob();
    return new Promise((ok, no) => {
      const r = new FileReader();
      r.onload = () => ok(r.result);
      r.onerror = no;
      r.readAsDataURL(blob);
    });
  }

  // ---- changing the character ----

  const norm = c => {
    const d = document.createElement('div');
    d.style.backgroundColor = c;
    return d.style.backgroundColor;
  };

  // best effort: opens the picker for a body part and follows the swatch with the matching colour
  async function setColor(part, rgb) {
    const res = await hit(`${base}?c=Hats&p=1&pick=${part}`);
    if (!res.ok) return false;
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const want = norm(rgb);
    const swatch = [...doc.querySelectorAll('a[href]')].find(
      a => !a.closest('.ColorChooserFrame') && a.style.backgroundColor && norm(a.style.backgroundColor) === want
    );
    const href = swatch && swatch.getAttribute('href');
    if (!href || href.startsWith('javascript:')) return false;
    return (await hit(new URL(href, location.href))).ok;
  }

  // ---- which items are still available (in the wardrobe or currently worn) ----

  const categories = () => {
    const seen = new Set();
    return [...document.querySelectorAll('.AttireChooser .AttireCategory a[href*="c="]')]
      .map(a => { try { return new URL(a.href, location.href).searchParams.get('c'); } catch (e) { return null; } })
      .filter(c => c && !seen.has(c) && seen.add(c));
  };

  // null means the request failed, so we never mistake a network error for a removed item
  async function pageIds(c, p) {
    try {
      const res = await hit(`${base}?${new URLSearchParams({ c, p })}`);
      if (!res.ok) return null;
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const ids = [...doc.querySelectorAll('.AttireChooser > .AttireOptions .Asset a[href]')]
        .map(a => (a.getAttribute('href').match(/(?:wear|remove)=(\d+)/) || [])[1])
        .filter(Boolean);
      const m = (doc.querySelector('.AttireChooser > .FooterPager')?.textContent || '').match(/Page\s+\d+\s+of\s+(\d+)/i);
      return { ids, pages: m ? Math.min(+m[1], 200) : 1 };
    } catch (e) {
      return null;
    }
  }

  let wardrobe = null; // { at, ids, complete }
  async function loadWardrobe(onProgress, force) {
    if (!force && wardrobe && Date.now() - wardrobe.at < 60000) return wardrobe;
    const queue = categories();
    const total = queue.length;
    const ids = new Set();
    let complete = total > 0;
    let done = 0;

    async function worker() {
      while (queue.length) {
        const c = queue.shift();
        const first = await pageIds(c, 1);
        if (!first) { complete = false; continue; }
        first.ids.forEach(id => ids.add(id));
        for (let p = 2; p <= first.pages; p++) {
          const r = await pageIds(c, p);
          if (!r) { complete = false; break; }
          r.ids.forEach(id => ids.add(id));
        }
        onProgress(`checking items… ${++done}/${total}`);
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker));

    readWorn().forEach(i => ids.add(i.id));
    return (wardrobe = { at: Date.now(), ids, complete });
  }

  const goneFrom = (o, w) => (w.complete ? o.items.filter(i => !w.ids.has(i.id)) : []);

  async function wear(o, setMsg) {
    const w = await loadWardrobe(setMsg);
    const gone = goneFrom(o, w);
    const goneIds = new Set(gone.map(i => i.id));

    const have = readWorn().map(i => i.id);
    const want = o.items.map(i => i.id).filter(id => !goneIds.has(id));

    for (const id of have.filter(id => !want.includes(id))) {
      setMsg('removing…');
      await hit(`${base}?c=Hats&p=1&remove=${id}`);
      await wait(120);
    }
    for (const id of want.filter(id => !have.includes(id))) {
      setMsg('wearing…');
      await hit(`${base}?c=Hats&p=1&wear=${id}`);
      await wait(120);
    }

    const now = readColors();
    let colorMiss = 0;
    for (const [part, rgb] of Object.entries(o.colors || {})) {
      if (now[part] && norm(now[part]) === norm(rgb)) continue;
      setMsg('colours…');
      if (!(await setColor(part, rgb))) colorMiss++;
    }

    await hit(`${base}?c=Hats&p=1&redraw=1`);

    // check what actually ended up on the character
    const res = await hit(`${base}?c=Hats&p=1`);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const worn = readWorn(doc).map(i => i.id);
    const failed = o.items.filter(i => !goneIds.has(i.id) && !worn.includes(i.id));

    const notes = [];
    const unowned = failed.filter(i => !w.ids.has(i.id));
    const blocked = failed.filter(i => w.ids.has(i.id)); // owned but refused, e.g. the hat limit
    if (blocked.length) notes.push(`couldn't be worn (hat limit?): ${blocked.map(i => i.name).join(', ')}`);
    if (colorMiss) notes.push(`${colorMiss} colour${colorMiss > 1 ? 's' : ''} not applied`);
    try {
      sessionStorage.setItem('ox_msg', `wearing "${o.name}"` + (notes.length ? ` (${notes.join(', ')})` : ''));
      if (gone.length || unowned.length) sessionStorage.setItem('ox_missing', JSON.stringify({ id: o.id, name: o.name, items: gone.concat(unowned) }));
    } catch (e) {}
    location.hash = '#outfits';
    location.reload();
  }

  // ---- item prices and buying ----

  const num = t => { const m = (t || '').replace(/,/g, '').match(/\d+/); return m ? +m[0] : null; };

  // robux / tix are numbers, or null when that currency isn't offered
  async function itemInfo(id) {
    try {
      const res = await hit(`/Item.aspx?ID=${id}`);
      if (!res.ok) return { id, robux: null, tix: null };
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const robux = doc.getElementById('ctl00_cphRoblox_PurchaseWithRobuxButton') ? num(doc.getElementById('PriceInRobux')?.textContent) : null;
      const tix = doc.getElementById('ctl00_cphRoblox_PurchaseWithTicketsButton') ? num(doc.getElementById('PriceInTickets')?.textContent) : null;
      return { id, robux, tix };
    } catch (e) {
      return { id, robux: null, tix: null };
    }
  }

  const isFree = i => i.robux === 0 || i.tix === 0;

  async function purchase(id, kind) {
    const url = `/Item.aspx?ID=${id}`;
    const res = await hit(url);
    if (!res.ok) return false;
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const form = doc.querySelector('form');
    if (!form) return false;
    const body = new URLSearchParams();
    form.querySelectorAll('input[name], select[name], textarea[name]').forEach(el => {
      const t = (el.type || '').toLowerCase();
      if (['submit', 'button', 'image', 'file'].includes(t)) return;
      if ((t === 'checkbox' || t === 'radio') && !el.checked) return;
      body.set(el.name, el.value);
    });
    body.set('__EVENTTARGET', kind === 'tix' ? 'ctl00$cphRoblox$PurchaseWithTicketsButton' : 'ctl00$cphRoblox$PurchaseWithRobuxButton');
    body.set('__EVENTARGUMENT', '');
    const post = await fetch(new URL(form.getAttribute('action') || url, location.origin + url), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    return post.ok;
  }

  // ---- popup (same look as the site's modalPopup) ----

  const pop = document.createElement('div');
  pop.id = 'ox-pop';
  pop.hidden = true;
  pop.innerHTML = '<div class="modalPopup"><div class="ox-pop-body"></div></div>';
  const popBody = pop.querySelector('.ox-pop-body');
  document.documentElement.append(pop);
  const closePop = () => { pop.hidden = true; popBody.innerHTML = ''; };
  const openPop = html => { popBody.innerHTML = html; pop.hidden = false; };
  pop.addEventListener('click', e => {
    if (e.target === pop || e.target.closest('[data-pop="cancel"]')) closePop();
  });

  const itemLink = i => `<a href="/Item.aspx?ID=${esc(i.id)}" target="_blank">${esc(i.name)}</a>`;

  const buyAll = async (picks, setLine) => {
    let ok = 0;
    const bad = [];
    for (const p of picks) {
      setLine(`buying ${ok + bad.length + 1}/${picks.length}…`);
      let done = false;
      try { done = await purchase(p.id, p.kind); } catch (e) {}
      (done ? (ok++, null) : bad.push(p.name));
    }
    // trust the wardrobe, not the response
    const w = await loadWardrobe(() => {}, true);
    const owned = picks.filter(p => w.ids.has(p.id));
    const failed = picks.filter(p => !w.ids.has(p.id));
    return { owned, failed };
  };

  const resultPop = ({ owned, failed }) => {
    openPop(`
      <div>${owned.length ? `Bought ${owned.length} item${owned.length === 1 ? '' : 's'}.` : 'Nothing was bought.'}</div>
      ${failed.length ? `<div>Couldn't buy:<br />${failed.map(i => esc(i.name)).join('<br />')}</div>` : ''}
      <div class="ox-pop-btns"><input type="button" class="Button" value="OK" data-pop="cancel" /></div>`);
  };

  // free items found while importing: one click to get them
  function freePop(free, paidCount) {
    openPop(`
      <div>You have ${free.length} free hat${free.length === 1 ? '' : 's'} missing</div>
      <div class="ox-pop-list">${free.map(i => `<div class="ox-row"><label><input type="checkbox" data-id="${esc(i.id)}" checked /> ${itemLink(i)}</label></div>`).join('')}</div>
      ${paidCount ? `<div>${paidCount} more cost${paidCount === 1 ? 's' : ''} money, you'll be told when you wear the outfit.</div>` : ''}
      <div class="ox-pop-btns">
        <input type="button" class="Button" value="buy" data-pop="buy" />
        <input type="button" class="Button" value="Cancel" data-pop="cancel" />
      </div>`);
    popBody.querySelector('[data-pop="buy"]').addEventListener('click', async () => {
      const keep = new Set([...popBody.querySelectorAll('input[type=checkbox]:checked')].map(c => c.dataset.id));
      const picks = free.filter(i => keep.has(i.id)).map(i => ({ id: i.id, name: i.name, kind: i.robux === 0 ? 'robux' : 'tix' }));
      if (!picks.length) return; // nothing ticked
      const line = popBody.querySelector('.ox-pop-btns');
      line.textContent = 'buying…';
      resultPop(await buyAll(picks, t => { line.textContent = t; }));
    });
  }

  // missing items after wearing: pick what to buy and with what
  function missingPop(name, rows, outfitId) {
    // the site's own currency icons (sprite classes from its stylesheet)
    const icon = k => `<div class="icons ${k === 'robux' ? 'robux_icon' : 'tickets_icon'}"></div>`;
    const price = (i, k, label) => i[k] === null ? '' :
      `<label title="buy with ${label}"><input type="checkbox" data-id="${esc(i.id)}" data-kind="${k}" />${icon(k)}</label>`;
    openPop(`
      <div>You have ${rows.length} hat${rows.length === 1 ? '' : 's'} missing${name ? ` for "${esc(name)}"` : ''}</div>
      <div class="ox-total"></div>
      <div class="ox-pop-list">${rows.map(i => `
        <div class="ox-row" data-id="${esc(i.id)}">
          ${price(i, 'robux', 'robux')} ${price(i, 'tix', 'tix')}
          ${itemLink(i)}
          <span class="ox-price">${i.robux === null && i.tix === null ? '(not for sale)' : [i.robux !== null ? `${icon('robux')}${i.robux}` : '', i.tix !== null ? `${icon('tix')}${i.tix}` : ''].filter(Boolean).join(' ')}</span>
        </div>`).join('')}</div>
      <div class="ox-pop-btns">
        <input type="button" class="Button" value="buy" data-pop="buy" />
        <input type="button" class="Button" value="cancel" data-pop="cancel" />
      </div>`);
    // balance left after the ticked purchases (balances come from the site's header)
    const bal = sel => num(document.querySelector(sel)?.textContent);
    const have = { robux: bal('.RobuxAlertCaption'), tix: bal('.TicketsAlertCaption') };
    const totalEl = popBody.querySelector('.ox-total');
    const updateTotal = () => {
      if (have.robux === null && have.tix === null) { totalEl.hidden = true; return; }
      const spent = { robux: 0, tix: 0 };
      popBody.querySelectorAll('input[type=checkbox]:checked').forEach(c => {
        const i = rows.find(r => r.id === c.dataset.id);
        if (i && i[c.dataset.kind] !== null) spent[c.dataset.kind] += i[c.dataset.kind];
      });
      const part = (k, cls) => have[k] === null ? '' :
        `<span class="${cls}${have[k] - spent[k] < 0 ? ' ox-neg' : ''}">${icon(k)}${have[k] - spent[k]}</span>`;
      totalEl.innerHTML = `Total after purchases: ${part('robux', 'ox-robux')} ${part('tix', 'ox-tix')}`;
    };
    updateTotal();

    // one currency per item
    popBody.addEventListener('change', e => {
      const c = e.target;
      if (c.checked) c.closest('.ox-row')?.querySelectorAll('input[type=checkbox]').forEach(x => { if (x !== c) x.checked = false; });
      updateTotal();
    });
    popBody.querySelector('[data-pop="buy"]').addEventListener('click', async () => {
      const picks = [...popBody.querySelectorAll('input[type=checkbox]:checked')].map(c => {
        const i = rows.find(r => r.id === c.dataset.id);
        return { id: i.id, name: i.name, kind: c.dataset.kind };
      });
      if (!picks.length) return;
      const line = popBody.querySelector('.ox-pop-btns');
      line.textContent = 'buying…';
      const res = await buyAll(picks, t => { line.textContent = t; });
      // bought something: put the outfit on again, now with the new items
      const o = res.owned.length && outfitId ? (await store.get()).find(x => x.id === outfitId) : null;
      if (!o) { resultPop(res); return; }
      line.textContent = 'wearing…';
      try { await wear(o, t => { line.textContent = t; }); }
      catch (err) { resultPop(res); }
    });
  }

  async function showMissing(name, items, outfitId) {
    const info = await Promise.all(items.map(i => itemInfo(i.id)));
    missingPop(name, items.map((i, n) => ({ ...i, ...info[n] })), outfitId);
  }

  // ---- ui (nodes are created once and re-attached whenever the site rebuilds the page) ----

  const panel = document.createElement('div');
  panel.id = 'ox-panel';
  panel.className = 'AttireOptions';
  panel.style.display = 'none';
  panel.innerHTML = `
    <div class="Asset ox-bar">
      <label for="ox-name">Name / search:</label><br />
      <input id="ox-name" type="text" maxlength="40" placeholder="outfit name / search" /><br />
      <a href="#" data-act="save">[ save current outfit ]</a><br />
      <a href="#" data-act="export">[ export outfits ]</a><br />
      <a href="#" data-act="import">[ import outfits ]</a>
      <input id="ox-file" type="file" accept=".json,application/json" hidden />
      <div id="ox-msg"></div>
    </div>
    <div style="clear:both;"></div>`;

  const bar = panel.querySelector('.ox-bar');
  const nameInput = panel.querySelector('#ox-name');
  const msgEl = panel.querySelector('#ox-msg');
  const setMsg = t => { msgEl.textContent = t || ''; };

  const tab = document.createElement('a');
  tab.id = 'ox-tab';
  tab.className = 'AttireCategorySelector';
  tab.href = '#outfits';
  tab.textContent = 'Outfits';
  const sep = document.createTextNode(' | ');

  const stock = () => {
    const chooser = document.querySelector('.AttireChooser');
    return chooser ? [chooser.querySelector(':scope > .AttireOptions:not(#ox-panel)'), chooser.querySelector(':scope > .FooterPager')] : [];
  };

  function open() {
    const cats = document.querySelector('.AttireChooser .AttireCategory');
    stock().forEach(el => { if (el) el.style.display = 'none'; });
    if (cats) cats.querySelectorAll('a.AttireCategorySelector_Selected').forEach(a => { a.className = 'AttireCategorySelector'; });
    tab.className = 'AttireCategorySelector_Selected';
    panel.style.display = '';
    render();
  }

  tab.addEventListener('click', e => {
    e.preventDefault();
    location.hash = '#outfits';
    open();
  });

  function mount() {
    const chooser = document.querySelector('.AttireChooser');
    const cats = chooser && chooser.querySelector('.AttireCategory');
    if (!cats) return;
    let changed = false;

    if (tab.parentNode !== cats) {
      const pg = cats.querySelector(':scope > .FooterPager'); // the search ext keeps its pager in here; tab goes before it
      pg ? pg.before(sep, tab) : cats.append(sep, tab);
      changed = true;
    }
    if (panel.parentNode !== chooser) {
      const [options] = stock();
      (options || cats).after(panel);
      changed = true;
    }
    if (!changed) return;

    if (location.hash === '#outfits') open();
    else panel.style.display = 'none';
  }

  async function render() {
    const all = await store.get();
    const terms = nameInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = terms.length
      ? all.filter(o => { const hay = o.name.toLowerCase(); return terms.every(t => hay.includes(t)); })
      : all;
    panel.querySelectorAll('.ox-card, .ox-empty').forEach(n => n.remove());
    if (!list.length) {
      bar.insertAdjacentHTML('afterend', `<div class="ox-empty">${all.length ? 'No outfits match that. Hit save to keep it as a new name.' : 'No outfits yet. Put something on, name it and hit save.'}</div>`);
      return;
    }
    bar.insertAdjacentHTML('afterend', list.map(o => `
      <div class="Asset ox-card" data-id="${esc(o.id)}">
        <div class="AssetThumbnail">
          <a data-act="wear" title="${esc(o.items.map(i => i.name).join(', ') || 'nothing worn')}" style="display:inline-block;cursor:pointer;"><img src="${esc(o.image)}" width="110" height="110" border="0" alt="${esc(o.name)}" /></a>
          <div class="ox-tag"><a data-act="wear">[ wear ]</a></div>
        </div>
        <div class="AssetDetails">
          <div class="AssetName"><a data-act="wear" style="cursor:pointer;">${esc(o.name)}</a></div>
          <div class="AssetCreator"><span class="Label">Items:</span> <span class="Detail">${o.items.length}</span></div>
          <div class="ox-links"><a data-act="update">update</a> | <a data-act="rename">rename</a> | <a data-act="delete">delete</a></div>
        </div>
      </div>`).join(''));
  }

  async function busy(fn) {
    panel.classList.add('ox-busy');
    try { await fn(); }
    catch (err) { setMsg('failed: ' + err.message); }
    finally { panel.classList.remove('ox-busy'); }
  }

  function download(list) {
    const data = { version: 1, exported: new Date().toISOString(), outfits: list };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `outfits-${getUid()}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const snapshot = async () => ({ items: readWorn(), colors: readColors(), image: await grabImage() });

  panel.addEventListener('click', e => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    e.preventDefault();
    const act = a.dataset.act;
    const id = a.closest('.Asset')?.dataset.id;

    if (act === 'import') { fileInput.click(); return; } // must happen inside the click, before any await

    busy(async () => {
      const list = await store.get();
      const o = list.find(x => x.id === id);

      if (act === 'export') {
        if (!list.length) { setMsg('nothing to export yet'); return; }
        download(list);
        setMsg(`exported ${list.length} outfit${list.length === 1 ? '' : 's'}`);
        return;
      }

      if (act === 'save') {
        setMsg('saving…');
        const name = nameInput.value.trim() || `outfit ${list.length + 1}`;
        const now = Date.now();
        list.push({ id: now.toString(36), name, created: now, updated: now, ...(await snapshot()) });
        await store.set(list);
        nameInput.value = '';
        setMsg(`saved "${name}"`);
      } else if (act === 'wear' && o) {
        await wear(o, setMsg);
      } else if (act === 'update' && o) {
        if (!confirm(`Overwrite "${o.name}" with what you're wearing now?`)) return;
        setMsg('updating…');
        Object.assign(o, await snapshot(), { updated: Date.now() });
        await store.set(list);
        setMsg(`updated "${o.name}"`);
      } else if (act === 'rename' && o) {
        const n = prompt('New name:', o.name);
        if (!n || !n.trim()) return;
        o.name = n.trim().slice(0, 40);
        await store.set(list);
      } else if (act === 'delete' && o) {
        if (!confirm(`Delete "${o.name}"?`)) return;
        await store.set(list.filter(x => x.id !== id));
        setMsg('deleted');
      }
      await render();
    });
  });

  // imported files are untrusted: keep only known fields in known shapes
  function clean(r) {
    if (!r || typeof r !== 'object' || !Array.isArray(r.items)) return null;
    if (typeof r.image !== 'string' || !/^data:(image\/[a-z0-9.+-]+|application\/octet-stream);base64,[A-Za-z0-9+/=]+$/.test(r.image)) return null;
    const items = r.items
      .filter(i => i && /^\d+$/.test(String(i.id)))
      .map(i => ({ id: String(i.id), name: String(i.name || i.id).slice(0, 120) }));
    const colors = {};
    if (r.colors && typeof r.colors === 'object') {
      for (const [k, v] of Object.entries(r.colors)) {
        if (typeof v === 'string' && v.length < 40) colors[String(k).slice(0, 20)] = v;
      }
    }
    const now = Date.now();
    return {
      id: String(r.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 24) || now.toString(36),
      name: String(r.name || 'outfit').slice(0, 40),
      created: +r.created || now,
      updated: +r.updated || now,
      items,
      colors,
      image: r.image,
    };
  }

  const fileInput = panel.querySelector('#ox-file');
  fileInput.addEventListener('change', () => busy(async () => {
    const file = fileInput.files[0];
    fileInput.value = ''; // so the same file can be picked again
    if (!file) return;
    if (file.size > 50e6) throw new Error('file is too big');

    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { throw new Error('that is not a valid json file'); }
    const incoming = Array.isArray(data) ? data : data && data.outfits;
    if (!Array.isArray(incoming)) throw new Error('no outfits found in that file');

    const list = await store.get();
    const have = new Set(list.map(o => o.id));
    let added = 0, skipped = 0;
    const order = [];
    const seen = [];
    for (const raw of incoming) {
      const o = clean(raw);
      if (!o) { skipped++; continue; }
      order.push(o.id);
      seen.push(o);
      if (have.has(o.id)) { skipped++; continue; }
      have.add(o.id);
      list.push(o);
      added++;
    }

    // follow the file's order; anything not in the file keeps its place after those
    const byId = new Map(list.map(o => [o.id, o]));
    const ordered = [];
    for (const id of order) {
      if (byId.has(id)) { ordered.push(byId.get(id)); byId.delete(id); }
    }
    await store.set(ordered.concat(list.filter(o => byId.has(o.id))));
    setMsg(`imported ${added}` + (skipped ? `, skipped ${skipped} (already here or invalid)` : ''));
    await render();

    // look for items the imported outfits use that aren't owned (every valid outfit in the file, even ones already here)
    if (!seen.length) return;
    const done = msgEl.textContent;
    setMsg('checking which items you own…');
    const w = await loadWardrobe(setMsg, true);
    if (!w.complete) { setMsg(done + ' (couldn\'t check your wardrobe for missing items)'); return; }
    const miss = new Map();
    seen.forEach(o => goneFrom(o, w).forEach(i => miss.set(i.id, i)));
    if (!miss.size) { setMsg(done + ', no missing items'); return; }
    setMsg(done + `, ${miss.size} missing item${miss.size === 1 ? '' : 's'}`);
    const info = await Promise.all([...miss.keys()].map(itemInfo));
    const free = info.filter(isFree).map(i => ({ ...miss.get(i.id), ...i }));
    if (free.length) freePop(free, miss.size - free.length);
    else openPop(`
      <div>You have ${miss.size} hat${miss.size === 1 ? '' : 's'} missing</div>
      <div class="ox-pop-list">${info.map(i => itemLink(miss.get(i.id))).join('<br />')}</div>
      <div>None are free. You'll be able to buy them when you wear an outfit that uses them.</div>
      <div class="ox-pop-btns"><input type="button" class="Button" value="OK" data-pop="cancel" /></div>`);
  }));

  nameInput.addEventListener('input', () => render());
  nameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      panel.querySelector('[data-act="save"]').click();
    }
  });

  // removing a worn item while on the outfits tab shouldn't kick you off it (capture so the site's own handler doesn't run)
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('.Accoutrements a[href*="remove="]');
    if (!a || !panel.isConnected || panel.style.display === 'none') return;
    e.preventDefault();
    e.stopPropagation();
    hit(a.href).finally(() => location.reload());
  }, true);

  // the site rebuilds the wardrobe after wear/remove, which wipes the tab; put it back whenever that happens
  let queued = 0;
  new MutationObserver(() => {
    if (queued) return;
    queued = setTimeout(() => { queued = 0; mount(); }, 0);
  }).observe(document, { childList: true, subtree: true });

  mount();
  if (location.hash === '#outfits') {
    try {
      const m = sessionStorage.getItem('ox_msg');
      if (m) { setMsg(m); sessionStorage.removeItem('ox_msg'); }
      const mi = sessionStorage.getItem('ox_missing');
      if (mi) {
        sessionStorage.removeItem('ox_missing');
        const d = JSON.parse(mi);
        if (Array.isArray(d.items) && d.items.length) showMissing(String(d.name || ''), d.items.filter(i => /^\d+$/.test(String(i.id))), String(d.id || ''));
      }
    } catch (e) {}
  }
})();
