/* Isometric projection + drawing primitives. No dependencies. */
(function (root) {
  'use strict';
  const A = (root.Arisu = root.Arisu || {});

  const TW = 64; // tile width in world pixels
  const TH = 32; // tile height
  const ZH = 26; // pixels per unit of height

  // grid (x, y, z) -> world pixel [px, py]
  function P(x, y, z) {
    return [((x - y) * TW) / 2, ((x + y) * TH) / 2 - (z || 0) * ZH];
  }

  // ---- colour helpers (hex only) ----
  const cache = new Map();
  function parse(hex) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function toHex(r, g, b) {
    const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return '#' + c(r) + c(g) + c(b);
  }
  // f < 1 darkens, f > 1 lightens toward white
  function shade(hex, f) {
    const key = hex + '|' + f;
    let v = cache.get(key);
    if (v) return v;
    const [r, g, b] = parse(hex);
    v = f <= 1 ? toHex(r * f, g * f, b * f) : toHex(r + (255 - r) * (f - 1), g + (255 - g) * (f - 1), b + (255 - b) * (f - 1));
    cache.set(key, v);
    return v;
  }
  function mix(a, b, t) {
    const key = a + '>' + b + '|' + t;
    let v = cache.get(key);
    if (v) return v;
    const A1 = parse(a), B1 = parse(b);
    v = toHex(A1[0] + (B1[0] - A1[0]) * t, A1[1] + (B1[1] - A1[1]) * t, A1[2] + (B1[2] - A1[2]) * t);
    cache.set(key, v);
    return v;
  }
  function rgba(hex, a) {
    const [r, g, b] = parse(hex);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function faces(base) {
    const key = 'f|' + base;
    let v = cache.get(key);
    if (!v) {
      v = { top: shade(base, 1.16), left: shade(base, 0.84), right: shade(base, 0.62) };
      cache.set(key, v);
    }
    return v;
  }

  // ---- drawing ----
  function poly(ctx, pts, fill, stroke, lw) {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      if (i) ctx.lineTo(pts[i][0], pts[i][1]);
      else ctx.moveTo(pts[i][0], pts[i][1]);
    }
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw || 1;
      ctx.stroke();
    }
  }

  // quad lying on the horizontal plane z, covering [x0,x1] x [y0,y1]
  function floorQuad(ctx, x0, x1, y0, y1, z, fill, stroke, lw) {
    poly(ctx, [P(x0, y0, z), P(x1, y0, z), P(x1, y1, z), P(x0, y1, z)], fill, stroke, lw);
  }
  // quad on the plane y (the face that points down-left on screen)
  function faceY(ctx, x0, x1, y, z0, z1, fill, stroke, lw) {
    poly(ctx, [P(x0, y, z0), P(x1, y, z0), P(x1, y, z1), P(x0, y, z1)], fill, stroke, lw);
  }
  // quad on the plane x (the face that points down-right on screen)
  function faceX(ctx, x, y0, y1, z0, z1, fill, stroke, lw) {
    poly(ctx, [P(x, y0, z0), P(x, y1, z0), P(x, y1, z1), P(x, y0, z1)], fill, stroke, lw);
  }

  // cuboid at (x,y,z) with size (w,d,h). c = hex string or {top,left,right}
  function box(ctx, x, y, z, w, d, h, c) {
    const col = typeof c === 'string' ? faces(c) : c;
    faceX(ctx, x + w, y, y + d, z, z + h, col.right);
    faceY(ctx, x, x + w, y + d, z, z + h, col.left);
    floorQuad(ctx, x, x + w, y, y + d, z + h, col.top);
  }

  A.iso = { TW, TH, ZH, P, parse, toHex, shade, mix, rgba, faces, poly, floorQuad, faceX, faceY, box };
  if (typeof module !== 'undefined') module.exports = A;
})(typeof window !== 'undefined' ? window : globalThis);
