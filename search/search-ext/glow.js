(() => {
  chrome.storage.local.get('features').then(r => {
    if (!(r.features && r.features.glow === false)) run();
  }).catch(run);

  chrome.storage.onChanged.addListener(ch => { if (ch.features) location.reload(); });

  function run() {
  const ID = '164';
  const LINK = new RegExp(`(?:^|/)User\\.aspx\\?ID=${ID}(?:[&#]|$)`, 'i');

  function mark(el, text) {
    if (el.dataset.ssGlow) return;
    el.dataset.ssGlow = '1';
    el.dataset.text = text; // the blurred glow layer repeats this text
    el.classList.add('ss-glow');
  }

  function scan(root = document) {
    root.querySelectorAll('a[href]').forEach(a => {
      if (a.dataset.ssGlow || !LINK.test(a.getAttribute('href'))) return;
      const text = a.textContent.trim();
      // skip empty links and image links
      if (!text || a.querySelector('img')) return;
      mark(a, text);
    });

    // on the profile page itself the name is in the "<name>'s Profile" header
    const head = document.getElementById('ctl00_cphRoblox_rbxUserPane_lUserRobloxURL');
    const own = document.getElementById('ctl00_cphRoblox_rbxUserPane_hlUserRobloxURL');
    if (head && own && LINK.test(own.getAttribute('href') || '') && !head.querySelector('.ss-glow')) {
      const m = head.textContent.match(/^(.+?)('s Profile)\s*$/);
      if (m) {
        // own tag name so the site's header span rules (block/float/etc.) don't apply to it
        const span = document.createElement('ss-name');
        span.textContent = m[1];
        mark(span, m[1]);
        head.textContent = '';
        head.append(span, m[2]);
      }
    }
  }

  scan();
  let timer = 0;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(scan, 250);
  }).observe(document.body || document.documentElement, { childList: true, subtree: true });
  }
})();
