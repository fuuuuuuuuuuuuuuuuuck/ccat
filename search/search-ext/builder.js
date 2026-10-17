(() => {
  chrome.storage.local.get('features').then(r => {
    if (!(r.features && r.features.builder === false)) run();
  }).catch(run);

  chrome.storage.onChanged.addListener(ch => { if (ch.features) location.reload(); });

  function run() {
  const area = document.querySelector('.SelectorArea');
  const tiles = [...document.querySelectorAll('.HatMeshTile')];
  if (!area || !tiles.length) return;

  // the visible label is cut off with "...", the img alt has the whole name
  const names = tiles.map(t => (t.querySelector('img')?.alt || t.querySelector('.HatMeshName')?.textContent || '').toLowerCase());

  const input = document.createElement('input');
  input.id = 'ss-builder-input';
  input.type = 'text';
  input.placeholder = 'search hats';
  input.autocomplete = 'off';
  input.spellcheck = false;
  area.prepend(input);

  const count = document.createElement('span');
  count.id = 'ss-builder-count';
  input.after(count);

  function run() {
    const terms = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    tiles.forEach((t, i) => {
      const ok = terms.every(w => names[i].includes(w));
      t.style.display = ok ? '' : 'none';
      if (ok) shown++;
    });
    count.textContent = terms.length ? `${shown}/${tiles.length}` : '';
  }

  input.addEventListener('input', run);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') e.preventDefault(); // it sits inside the page's form
    if (e.key === 'Escape') { input.value = ''; run(); }
  });
  }
})();
