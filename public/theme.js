// Applies the color theme before the page paints, so there is no flash of
// the wrong one. A saved choice wins; otherwise the device's setting, and the
// page follows that setting live until the visitor picks one themselves.
(function () {
  var KEY = 'chartgauge_theme', saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  function pick() { return saved === 'light' || saved === 'dark' ? saved : (mq && mq.matches ? 'light' : 'dark'); }
  document.documentElement.setAttribute('data-theme', pick());
  if (mq && mq.addEventListener) mq.addEventListener('change', function () {
    try { saved = localStorage.getItem(KEY); } catch (e) {}
    if (saved !== 'light' && saved !== 'dark') {
      document.documentElement.setAttribute('data-theme', pick());
      window.dispatchEvent(new Event('themechange'));
    }
  });
})();
