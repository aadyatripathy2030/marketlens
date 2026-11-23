// Applies the color theme before the page paints, so there is no flash of
// the wrong one. Dark is the default; a visitor who picks light with the
// toggle keeps it, because the choice is saved.
(function () {
  var KEY = 'chartgauge_theme', saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  document.documentElement.setAttribute('data-theme', saved === 'light' ? 'light' : 'dark');
})();

// Device detection (Nov 23 2026), also before paint, so styles.css can give
// phones and tablets lighter motion from the first frame:
//   html.touch  any touch-first device (phone, tablet, touch-only laptop)
//   html.phone  a phone;  html.tablet  a tablet (iPadOS included)
//   html.weak   a low-end device or data saver on: heavy glass effects off
// window.CG_DEVICE carries the same answers for app.js and glass.js.
(function () {
  var d = document.documentElement, n = navigator, ua = n.userAgent || '';
  var mq = function (q) { try { return !!(window.matchMedia && window.matchMedia(q).matches); } catch (e) { return false; } };
  var touchPts = n.maxTouchPoints || 0;
  var coarse = mq('(pointer: coarse)') || (touchPts > 0 && !mq('(hover: hover)'));
  var ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPts > 1);
  var shortSide = Math.min(screen.width || 0, screen.height || 0);
  var phone = !ipad && (/iPhone|iPod|Android.+Mobile|Windows Phone|Mobi/.test(ua) || (coarse && shortSide > 0 && shortSide < 600));
  var tablet = !phone && (ipad || /Android|Tablet|Silk|Kindle/.test(ua) || (coarse && shortSide >= 600));
  var touch = phone || tablet || coarse;
  var c = n.connection || {};
  var weak = touch && (
    (n.deviceMemory && n.deviceMemory <= 4) ||
    (n.hardwareConcurrency && n.hardwareConcurrency <= 2) ||
    c.saveData === true || /(^|-)2g$/.test(c.effectiveType || ''));
  if (touch) d.classList.add('touch');
  if (phone) d.classList.add('phone');
  if (tablet) d.classList.add('tablet');
  if (weak) d.classList.add('weak');
  window.CG_DEVICE = { touch: !!touch, phone: !!phone, tablet: !!tablet, weak: !!weak };
})();
