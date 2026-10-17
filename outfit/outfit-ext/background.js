// checks the GitHub repo for a newer version and flags it; it never downloads or runs anything by itself
const REPO = 'fuuuuuuuuuuuuuuuuuck/ccat';
// the repo has one manifest.json at its root with a line per extension, e.g.
//   wardrobe=1.0.0
//   search=1.0.0
const KEYS = ['wardrobe', 'outfit', 'outfits']; // lines this extension reads
const BRANCHES = ['main', 'master'];

const newer = (a, b) => {
  const x = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const y = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
};

// "name=1.0.1" per line (a quoted json-style "name": "1.0.1" line works too)
const parse = text => {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*"?([A-Za-z0-9_-]+)"?\s*[=:]\s*"?([0-9][0-9.]*)"?\s*,?\s*$/);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
};

async function check() {
  for (const branch of BRANCHES) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${branch}/manifest.json`, { cache: 'no-store' });
      if (!res.ok) continue;
      const versions = parse(await res.text());
      const found = KEYS.map(k => versions[k]).find(Boolean);
      const have = chrome.runtime.getManifest().version;
      const update = found && newer(found, have)
        ? { version: found.slice(0, 20), repo: `https://github.com/${REPO}` }
        : null;
      await chrome.storage.local.set({ update, updateChecked: Date.now() });
      chrome.action.setBadgeBackgroundColor({ color: '#d33' });
      chrome.action.setBadgeText({ text: update ? 'NEW' : '' });
      return update;
    } catch (e) {}
  }
  await chrome.storage.local.set({ updateChecked: Date.now() }).catch(() => {});
  return null;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('check-update', { periodInMinutes: 360 });
  check();
});
chrome.runtime.onStartup.addListener(check);
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'check-update') check(); });

// the Character page pings this on every load; keep it from hammering GitHub when pages load back to back
const MIN_GAP = 30 * 1000;
chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (msg === 'check-update') { check().then(send); return true; }
  if (msg === 'page-visit') {
    chrome.storage.local.get('updateChecked').then(r => {
      if (Date.now() - (r.updateChecked || 0) > MIN_GAP) check();
    });
  }
});
