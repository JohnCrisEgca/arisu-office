/* A tiny 5x7 bitmap font, used to draw the "Arisu Office" wordmark as SVG
   so the logo is crisp and works offline (no font download). */
(function (root) {
  'use strict';
  const A = (root.Arisu = root.Arisu || {});

  const G = {
    A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
    I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
    S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
    U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
    C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
    E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  };

  // parts: [{ text, color }]; returns an SVG string
  function wordmark(parts, opt) {
    const s = (opt && opt.scale) || 3;
    const shadow = opt && opt.shadow;
    let col = 0;
    const rects = [];
    const shadows = [];
    for (const p of parts) {
      for (const ch of p.text.toUpperCase()) {
        const g = G[ch];
        if (!g) {
          col += 3;
          continue;
        }
        for (let r = 0; r < 7; r++) {
          for (let c = 0; c < 5; c++) {
            if (g[r][c] !== '#') continue;
            rects.push('<rect x="' + (col + c) * s + '" y="' + r * s + '" width="' + s + '" height="' + s + '" fill="' + p.color + '"/>');
            if (shadow) shadows.push('<rect x="' + ((col + c) * s + s * 0.6) + '" y="' + (r * s + s * 0.6) + '" width="' + s + '" height="' + s + '" fill="' + shadow + '"/>');
          }
        }
        col += 6;
      }
    }
    const w = (col - 1) * s + (shadow ? s : 0);
    const h = 7 * s + (shadow ? s : 0);
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" shape-rendering="crispEdges" role="img" aria-label="' + parts.map((p) => p.text).join(' ') + '">' + shadows.join('') + rects.join('') + '</svg>';
  }

  A.pixelfont = { wordmark, glyphs: G };
  if (typeof module !== 'undefined') module.exports = A;
})(typeof window !== 'undefined' ? window : globalThis);
