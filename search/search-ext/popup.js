const sel = document.getElementById('rows');
const boxes = [...document.querySelectorAll('input[data-feature]')];

chrome.storage.local.get(['rows', 'features']).then(r => {
  sel.value = String(r.rows || 2);
  const f = r.features || {};
  boxes.forEach(b => { b.checked = f[b.dataset.feature] !== false; });
});

sel.addEventListener('change', () => chrome.storage.local.set({ rows: +sel.value }));

boxes.forEach(b => b.addEventListener('change', async () => {
  const f = (await chrome.storage.local.get('features')).features || {};
  f[b.dataset.feature] = b.checked;
  chrome.storage.local.set({ features: f });
}));

// update banner (a newer version is in the GitHub repo)
const banner = document.getElementById('update');
function showUpdate(u) {
  if (!u) { banner.hidden = true; return; }
  const a = document.createElement('a');
  a.href = u.repo;
  a.target = '_blank';
  a.textContent = 'open the repo';
  banner.textContent = `Update ${u.version} available: `;
  banner.append(a, ' (download it, unzip, then reload the extension)');
  banner.hidden = false;
}
chrome.storage.local.get('update').then(r => showUpdate(r.update));
chrome.runtime.sendMessage('check-update').then(showUpdate).catch(() => {});
