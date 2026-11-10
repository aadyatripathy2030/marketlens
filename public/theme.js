// Applies the color theme before the page paints, so there is no flash of
// the wrong one. Dark is the default; a visitor who picks light with the
// toggle keeps it, because the choice is saved.
(function () {
  var KEY = 'chartgauge_theme', saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  document.documentElement.setAttribute('data-theme', saved === 'light' ? 'light' : 'dark');
})();
