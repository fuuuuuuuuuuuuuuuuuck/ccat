const banner = document.getElementById('update');
const ok = document.getElementById('ok');
ok.textContent = `outfits v${chrome.runtime.getManifest().version}`;

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
