// Liquid glass refraction (Nov 8 2026).
//
// The glass surfaces (the header and the sign-in code boxes) get their frosted fill, bright rim and
// reflection from styles.css. This adds the refraction: what sits behind a
// panel bends near its edges, as it would through a thick piece of glass.
//
// How: each panel gets an SVG filter whose displacement map is drawn for its
// exact size. The map is neutral in the middle and pushes the backdrop
// outward in a band along every edge, so the bend has the same width on a
// wide header as on a small button. The filter is applied through
// backdrop-filter: url(), which only Chromium supports; other browsers keep
// the frosted glass without the bend. Off for reduced motion and reduced
// transparency, where the panels fall back to their plain frosted look.
(function () {
  var brands = navigator.userAgentData && navigator.userAgentData.brands;
  var chromium = !!(brands && brands.some(function (b) { return /Chromium/.test(b.brand); }));
  var mq = function (q) { return window.matchMedia && window.matchMedia(q).matches; };
  if (!chromium || mq('(prefers-reduced-motion: reduce)') || mq('(prefers-reduced-transparency: reduce)')) return;
  document.documentElement.classList.add('lg-refract');

  var SEL = '.topbar, .otp-box';
  var SVGNS = 'http://www.w3.org/2000/svg';
  var defs = document.createElementNS(SVGNS, 'svg');
  defs.setAttribute('width', '0'); defs.setAttribute('height', '0'); defs.setAttribute('aria-hidden', 'true');
  defs.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  document.body.appendChild(defs);
  var made = {};

  // The map: red moves pixels sideways, green up and down, 128 is still.
  // Inside an edge band the push rises with a smooth curve toward the rim.
  function mapUrl(w, h, band) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var ctx = c.getContext('2d'), img = ctx.createImageData(w, h), d = img.data;
    var bx = Math.min(band, w / 2), by = Math.min(band, h / 2);
    var col = new Float32Array(w), row = new Float32Array(h);
    for (var x = 0; x < w; x++) { var l = x / bx, r = (w - 1 - x) / bx; col[x] = l < 1 ? -Math.pow(1 - l, 2) : r < 1 ? Math.pow(1 - r, 2) : 0; }
    for (var y = 0; y < h; y++) { var t = y / by, b = (h - 1 - y) / by; row[y] = t < 1 ? -Math.pow(1 - t, 2) : b < 1 ? Math.pow(1 - b, 2) : 0; }
    for (var j = 0, i = 0; j < h; j++) for (var k = 0; k < w; k++, i += 4) {
      d[i] = 128 + 127 * col[k]; d[i + 1] = 128 + 127 * row[j]; d[i + 2] = 128; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }

  function filterFor(w, h, kind) {
    var band = kind === 'bar' ? 22 : Math.min(18, h / 2);
    var scale = kind === 'bar' ? 26 : 28;
    var id = 'lg-' + kind + '-' + w + 'x' + h;
    if (made[id]) return id;
    var f = document.createElementNS(SVGNS, 'filter');
    f.setAttribute('id', id); f.setAttribute('filterUnits', 'userSpaceOnUse'); f.setAttribute('primitiveUnits', 'userSpaceOnUse');
    f.setAttribute('x', '0'); f.setAttribute('y', '0'); f.setAttribute('width', w); f.setAttribute('height', h);
    f.setAttribute('color-interpolation-filters', 'sRGB');
    var im = document.createElementNS(SVGNS, 'feImage');
    im.setAttribute('href', mapUrl(w, h, band)); im.setAttribute('x', '0'); im.setAttribute('y', '0');
    im.setAttribute('width', w); im.setAttribute('height', h); im.setAttribute('preserveAspectRatio', 'none'); im.setAttribute('result', 'map');
    var dm = document.createElementNS(SVGNS, 'feDisplacementMap');
    dm.setAttribute('in', 'SourceGraphic'); dm.setAttribute('in2', 'map'); dm.setAttribute('scale', scale);
    dm.setAttribute('xChannelSelector', 'R'); dm.setAttribute('yChannelSelector', 'G');
    f.appendChild(im); f.appendChild(dm); defs.appendChild(f);
    made[id] = true;
    return id;
  }

  function apply(el) {
    var r = el.getBoundingClientRect();
    var w = Math.round(r.width / 4) * 4, h = Math.round(r.height / 4) * 4;
    if (w < 8 || h < 8 || w * h > 2600000) { el.style.removeProperty('--lg-url'); return; }
    var kind = el.classList.contains('topbar') ? 'bar' : 'btn';
    el.style.setProperty('--lg-url', 'url(#' + filterFor(w, h, kind) + ')');
  }

  var ro = new ResizeObserver(function (entries) { entries.forEach(function (e) { apply(e.target); }); });
  var seen = new WeakSet();
  function scan() {
    document.querySelectorAll(SEL).forEach(function (el) { if (!seen.has(el)) { seen.add(el); ro.observe(el); } });
  }
  var pending = 0;
  new MutationObserver(function () { if (!pending) pending = requestAnimationFrame(function () { pending = 0; scan(); }); })
    .observe(document.body, { childList: true, subtree: true });
  scan();
})();
