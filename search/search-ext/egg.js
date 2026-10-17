// small gif in the bottom right corner; click it to play the clip over the page, it closes when the clip ends
(() => {
  if (window.top !== window) return;
  chrome.storage.local.get('features').then(r => {
    if (r.features && r.features.egg === false) return; // switched off in the popup
    start();
  }).catch(() => start());
  chrome.storage.onChanged.addListener(ch => { if (ch.features) location.reload(); });

  function start() {
  const url = f => chrome.runtime.getURL('egg/' + f);

  const btn = document.createElement('img');
  btn.id = 'ss-egg';
  btn.src = url('thumb.gif');
  btn.alt = '';
  btn.draggable = false;

  let wrap = null;
  const close = () => {
    if (!wrap) return;
    const v = wrap.querySelector('video');
    try { v.pause(); } catch (e) {}
    wrap.remove();
    wrap = null;
  };

  btn.addEventListener('click', () => {
    if (wrap) return;
    wrap = document.createElement('div');
    wrap.id = 'ss-egg-wrap';
    const v = document.createElement('video');
    v.src = url('clip.mp4');
    v.autoplay = true;
    v.playsInline = true;
    v.addEventListener('ended', close);
    v.addEventListener('error', close);
    wrap.append(v);
    wrap.addEventListener('click', close); // click anywhere to skip
    document.documentElement.append(wrap);
    v.play().catch(() => {});
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  // sits at the very end of the page (not floating over it), bottom right
  const foot = document.createElement('div');
  foot.id = 'ss-egg-foot';
  foot.append(btn);
  (document.body || document.documentElement).append(foot);
  }
})();
