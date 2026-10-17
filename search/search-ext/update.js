// in-page "new update" notice (same look as the site's popups). Only shows when background.js found a newer version.
// If both extensions have an update they share one popup, so they don't stack on each other.
(() => {
  const REPO_URL = 'https://github.com/fuuuuuuuuuuuuuuuuuck/ccat';
  const me = chrome.runtime.getManifest();
  const myId = chrome.runtime.id || me.name;
  const DAY = 24 * 60 * 60 * 1000;
  let handled = false; // already showing (or registered) for this page

  const mkButton = (value, act) => {
    const b = document.createElement('input');
    b.type = 'button';
    b.className = 'Button';
    b.value = value;
    b.dataset.a = act;
    return b;
  };

  function createBox() {
    const box = document.createElement('div');
    box.className = 'ssupd';
    const pop = document.createElement('div');
    pop.className = 'modalPopup';
    const body = document.createElement('div');
    body.className = 'ssupd-body';

    const title = document.createElement('div');
    title.className = 'ssupd-title';
    const lines = document.createElement('div');
    lines.className = 'ssupd-lines';

    const hide = document.createElement('div');
    hide.className = 'ssupd-hide';
    const label = document.createElement('label');
    const never = document.createElement('input');
    never.type = 'checkbox';
    never.className = 'ssupd-never';
    label.append(never, " Don't show again");
    hide.append(label);

    const btns = document.createElement('div');
    btns.className = 'ssupd-btns';
    btns.append(mkButton('Bring to repo', 'repo'), mkButton('Cancel', 'cancel'), mkButton('Ignore for 1d', 'snooze'));

    body.append(title, lines, hide, btns);
    pop.append(body);
    box.append(pop);
    document.documentElement.append(box);
    return box;
  }

  // one line per extension that has an update; the title depends on how many there are
  function render(box) {
    const lines = [...box.querySelectorAll('.ssupd-line')];
    const title = box.querySelector('.ssupd-title');
    if (lines.length > 1) {
      title.textContent = 'Both extensions have an update!';
      lines.forEach(l => { l.textContent = `${l.dataset.name}: version ${l.dataset.next} is out (you have ${l.dataset.have}).`; });
    } else if (lines.length === 1) {
      const l = lines[0];
      title.textContent = `${l.dataset.name} has a new update!`;
      l.textContent = `Version ${l.dataset.next} is out (you have ${l.dataset.have}).`;
    }
  }

  async function maybeShow(update) {
    if (handled || !update || !update.version) return;
    const prefs = (await chrome.storage.local.get('updatePrefs')).updatePrefs || {};
    if (prefs.hide === update.version) return; // "don't show again" (for this version)
    if (prefs.snoozeUntil && Date.now() < prefs.snoozeUntil && prefs.snoozeVersion === update.version) return;
    if (handled) return;
    handled = true;

    // from here to the end of the registration it's all synchronous, so the two extensions can't both create a box
    const box = document.querySelector('.ssupd') || createBox();
    const line = document.createElement('div');
    line.className = 'ssupd-line';
    line.dataset.id = myId;
    line.dataset.name = me.name;
    line.dataset.next = update.version;
    line.dataset.have = me.version;
    box.querySelector('.ssupd-lines').append(line);
    render(box);

    // each extension saves its own choice; the other one's listener does the same for itself
    box.addEventListener('click', async e => {
      const a = e.target.closest && e.target.closest('[data-a]');
      if (!a) return;
      const act = a.dataset.a;
      const next = { ...prefs };
      if (box.querySelector('.ssupd-never').checked) next.hide = update.version;
      if (act === 'snooze') { next.snoozeUntil = Date.now() + DAY; next.snoozeVersion = update.version; }
      if (act === 'repo' && !box.dataset.opened) { box.dataset.opened = '1'; window.open(REPO_URL, '_blank', 'noopener'); }
      try { await chrome.storage.local.set({ updatePrefs: next }); } catch (err) {}
      box.remove();
    });
  }

  chrome.storage.local.get('update').then(r => maybeShow(r.update)).catch(() => {});
  // the background check runs while the page loads, so it can land after this script started
  chrome.storage.onChanged.addListener(ch => { if (ch.update && ch.update.newValue) maybeShow(ch.update.newValue); });
})();
