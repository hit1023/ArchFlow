// ArchFlow 描画エンジン v2: ノードごとの「役割(behavior)」をシミュレートして描く。
// cache=ヒットすると戻る / queue=溜めて順次渡す / worker=処理中+待ち / lb=振り分け / fanout=複製 / filter=遮断 / batch=まとめ送り / label=札付け
(function (root) {
  var COLORS = { blue: "--k8s", teal: "--info", amber: "--loki", red: "--err", purple: "--purple", gray: "--muted" };
  var KIND_COLOR = { pod: "blue", file: "gray", agent: "amber", db: "amber", service: "teal", queue: "purple", user: "purple", cloud: "blue", generic: "gray" };
  var NW = 190, NH = 112, CW = 270, RH = 150, MX = 70, MT = 80, MB = 50, SP = 230;
  var TYPES = { pass: 1, cache: 1, queue: 1, worker: 1, lb: 1, fanout: 1, filter: 1, batch: 1, label: 1 };

  function ArchFlow(canvas, spec) {
    var ctx = canvas.getContext("2d");
    var nodes = {}, edges = [], sources = [], parts = [], fx = [];
    var now = 0, speed = 1, paused = false, last = 0, raf = 0, css = {}, loadMul = 1, loadUntil = 0;
    var maxCol = 0, maxRow = 0;

    spec.nodes.forEach(function (d) {
      var b = d.behavior || {}, type = TYPES[b.type] ? b.type : "pass";
      var n = { d: d, beh: b, type: type, hit: -9, count: 0, inbox: [], active: [], items: [], rel: [], out: [], rr: 0, cool: 0, lastEdge: null,
        st: { hit: 0, miss: 0, drop: 0, pass: 0, done: 0, fill: 0 } };
      n.conc = type === "worker" ? Math.max(1, Math.round(b.concurrency || 1)) : Infinity;
      n.time = b.time != null ? b.time : (type === "worker" ? 1.5 : type === "lb" ? 0.15 : 0.3);
      n.cap = Math.max(1, Math.round(b.capacity || (type === "queue" ? 12 : 8)));
      n.bsize = Math.max(2, Math.round(b.size || 5));
      nodes[d.id] = n; maxCol = Math.max(maxCol, d.col); maxRow = Math.max(maxRow, d.row);
    });
    var W = maxCol * CW + NW + MX * 2, H = maxRow * RH + NH + MT + MB;
    Object.keys(nodes).forEach(function (id) { var n = nodes[id]; n.x = MX + n.d.col * CW; n.y = MT + n.d.row * RH; n.cx = n.x + NW / 2; n.cy = n.y + NH / 2; });
    (spec.edges || []).forEach(function (e) {
      var a = nodes[e.from], b = nodes[e.to]; if (!a || !b) return;
      var ed = { a: a, b: b, label: e.label, flash: -9 }; edges.push(ed); a.out.push(ed);
    });
    (spec.sources || []).forEach(function (s) {
      if (!nodes[s.node]) return;
      var vs = (s.variants && s.variants.length) ? s.variants : [{ label: "", color: "teal", weight: 1 }];
      sources.push({ n: nodes[s.node], rate: Math.max(0.2, Math.min(6, s.rate || 1.5)), vs: vs, tw: vs.reduce(function (a, v) { return a + (v.weight || 1); }, 0), next: Math.random() * 0.5 });
    });
    Object.keys(nodes).forEach(function (id) { var n = nodes[id]; if (n.type === "cache") n.st.fill = 0; });

    var FALLBACK = { "--bg": "#f3f5f8", "--panel": "#fff", "--fg": "#14202e", "--muted": "#5d6b7d", "--line": "#c9d2dd", "--k8s": "#2f6fed", "--info": "#13a58a", "--loki": "#e08a00", "--err": "#e0453a", "--warn": "#d99a00", "--purple": "#8a5cf5" };
    function readCss() { var s = getComputedStyle(document.documentElement); Object.keys(FALLBACK).forEach(function (k) { css[k] = s.getPropertyValue(k).trim() || FALLBACK[k]; }); }
    function col(name) { return css[COLORS[name] || "--muted"] || css["--muted"]; }
    function nodeCol(n) { return col(n.d.color || KIND_COLOR[n.d.kind] || "gray"); }
    function rr(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
    function text(s, x, y, size, color, align, mono, weight, maxW) {
      ctx.font = (weight || 400) + " " + size + "px " + (mono ? '"IBM Plex Mono",ui-monospace,Menlo,monospace' : '"Noto Sans JP",system-ui,-apple-system,"Hiragino Sans",sans-serif');
      ctx.fillStyle = color; ctx.textAlign = align || "left"; ctx.textBaseline = "middle";
      if (maxW) ctx.fillText(s, x, y, maxW); else ctx.fillText(s, x, y);
    }
    function glow(t0, dur) { var d = now - t0; return d < 0 || d > dur ? 0 : 1 - d / dur; }

    // ---- シミュレーション ----
    function spawn(s) {
      var r = Math.random() * s.tw, v = s.vs[0];
      for (var i = 0; i < s.vs.length; i++) { r -= (s.vs[i].weight || 1); if (r <= 0) { v = s.vs[i]; break; } }
      var p = { v: v, trail: [], ret: false, chip: null, state: "node", dead: false };
      parts.push(p); arrive(p, s.n);
    }
    function startMove(p, from, to) {
      if (!p.ret) p.trail.push(from);
      p.from = from; p.to = to; p.d = 0; p.len = Math.hypot(to.cx - from.cx, to.cy - from.cy) || 1; p.state = "move";
    }
    function canAccept(n) { return n.type !== "worker" || n.active.length + n.inbox.length < n.conc; }
    function absorb(p, n) { n.count++; n.hit = now; p.dead = true; }
    function clone(p) { var q = {}; for (var k in p) q[k] = p[k]; q.trail = p.trail.slice(); parts.push(q); return q; }
    function route(p, n) {
      if (!n.out.length) { absorb(p, n); return; }
      if (n.type === "fanout") { n.out.forEach(function (e, i) { var q = i === 0 ? p : clone(p); e.flash = now; startMove(q, n, e.b); }); return; }
      var e = n.out[n.rr++ % n.out.length]; n.lastEdge = e; e.flash = now; startMove(p, n, e.b);
    }
    function enqueueActive(p, n) {
      p.state = "node";
      if (n.active.length < n.conc) { p.rem = p.tot = n.time * (0.85 + Math.random() * 0.3); n.active.push(p); } else n.inbox.push(p);
    }
    function arrive(p, n) {
      n.hit = now;
      if (p.ret) { if (p.trail.length) startMove(p, n, p.trail.pop()); else absorb(p, n); return; }
      if (n.type === "cache") {
        var prob = (n.beh.hitRate != null ? n.beh.hitRate : 0.8) * Math.min(1, 0.25 + 0.75 * n.st.fill / n.cap);
        if (Math.random() < prob && p.trail.length) { n.st.hit++; p.ret = true; p.hitFx = true; startMove(p, n, p.trail.pop()); return; }
        n.st.miss++; if (n.st.fill < n.cap) n.st.fill++;
      }
      if (n.type === "queue") {
        if (n.items.length >= n.cap) { n.st.drop++; fx.push({ x: n.cx, y: n.cy, t: now, s: "×" }); p.dead = true; return; }
        p.state = "queued"; n.items.push(p); return;
      }
      enqueueActive(p, n);
    }
    function finish(p, n) {
      n.st.done++;
      if (n.type === "filter") {
        if (Math.random() < (n.beh.dropRate != null ? n.beh.dropRate : 0.15)) { n.st.drop++; fx.push({ x: n.cx, y: n.cy, t: now, s: "×" }); p.dead = true; return; }
        n.st.pass++;
      }
      if (n.type === "label") p.chip = n.beh.text || "";
      if (n.type === "batch") {
        n.items.push(p); p.state = "queued";
        if (n.items.length >= n.bsize) { n.items.forEach(function (q, i) { n.rel.push({ p: q, at: now + 0.25 + i * 0.07 }); }); n.items = []; n.hit = now; }
        return;
      }
      route(p, n);
    }
    function update(dt) {
      now += dt;
      if (loadUntil && now > loadUntil) { loadMul = 1; loadUntil = 0; }
      sources.forEach(function (s) {
        s.next -= dt;
        while (s.next <= 0) { if (parts.length < 320) spawn(s); s.next += (0.6 + Math.random() * 0.8) / (s.rate * loadMul); }
      });
      parts.forEach(function (p) { if (p.state === "move" && !p.dead) { p.d += SP * dt; if (p.d >= p.len) arrive(p, p.to); } });
      Object.keys(nodes).forEach(function (id) {
        var n = nodes[id];
        for (var i = n.active.length - 1; i >= 0; i--) { var p = n.active[i]; p.rem -= dt; if (p.rem <= 0) { n.active.splice(i, 1); finish(p, n); } }
        while (n.inbox.length && n.active.length < n.conc) { var q = n.inbox.shift(); q.rem = q.tot = n.time * (0.85 + Math.random() * 0.3); n.active.push(q); }
        for (var j = n.rel.length - 1; j >= 0; j--) if (now >= n.rel[j].at) { var r = n.rel.splice(j, 1)[0]; route(r.p, n); }
        if (n.type === "queue") {
          n.cool -= dt;
          if (n.cool <= 0 && n.items.length && n.out.length) {
            for (var k = 0; k < n.out.length; k++) {
              var e = n.out[(n.rr + k) % n.out.length];
              if (canAccept(e.b)) { var h = n.items.shift(); n.rr = (n.rr + k + 1) % n.out.length; e.flash = now; n.lastEdge = e; startMove(h, n, e.b); n.cool = 0.16; break; }
            }
          }
        }
      });
      parts = parts.filter(function (p) { return !p.dead; });
      fx = fx.filter(function (f) { return now - f.t < 0.9; });
    }
    function pos(p) {
      var t = Math.min(1, p.d / p.len), x = p.from.cx + (p.to.cx - p.from.cx) * t, y = p.from.cy + (p.to.cy - p.from.cy) * t;
      if (p.ret) { var dx = p.to.cx - p.from.cx, dy = p.to.cy - p.from.cy, l = Math.hypot(dx, dy) || 1; x += -dy / l * 9; y += dx / l * 9; }
      return [x, y];
    }

    // ---- 描画 ----
    function edgePoint(n, dx, dy) { var l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l, t = Math.min(ux ? (NW / 2) / Math.abs(ux) : 1e9, uy ? (NH / 2) / Math.abs(uy) : 1e9); return [n.cx + ux * t, n.cy + uy * t, ux, uy]; }
    function drawArrow(e) {
      var p = edgePoint(e.b, e.a.cx - e.b.cx, e.a.cy - e.b.cy), x = p[0] + p[2] * 3, y = p[1] + p[3] * 3, ux = -p[2], uy = -p[3];
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - ux * 10 - uy * 5, y - uy * 10 + ux * 5); ctx.lineTo(x - ux * 10 + uy * 5, y - uy * 10 - ux * 5); ctx.closePath(); ctx.fillStyle = css["--line"]; ctx.fill();
    }
    function drawViz(n, c) {
      var x = n.x + 14, y = n.y, w = NW - 28, mut = css["--muted"], i;
      if (n.type === "cache") {
        var sl = Math.min(n.cap, 10), sw = (w - (sl - 1) * 3) / sl, fl = Math.round(n.st.fill / n.cap * sl);
        for (i = 0; i < sl; i++) { rr(x + i * (sw + 3), y + 56, sw, 10, 2); ctx.fillStyle = i < fl ? c : css["--bg"]; ctx.fill(); }
        var tot = n.st.hit + n.st.miss, pct = tot ? Math.round(n.st.hit / tot * 100) : 0;
        text("HIT " + pct + "%", x, y + 82, 12, css["--info"], "left", true, 500); text("MISS " + n.st.miss, x + w, y + 82, 11, mut, "right", true);
      } else if (n.type === "queue") {
        var cells = Math.min(n.cap, 14), cw = (w - (cells - 1) * 3) / cells;
        for (i = 0; i < cells; i++) { rr(x + i * (cw + 3), y + 54, cw, 16, 3); var it = n.items[i]; ctx.fillStyle = it ? col(it.v.color) : css["--bg"]; ctx.fill(); }
        var full = n.items.length >= n.cap * 0.8;
        text("待機 " + n.items.length + " / " + n.cap, x, y + 82, 12, full ? css["--err"] : css["--fg"], "left", true, 500);
        if (n.st.drop) text("溢れ " + n.st.drop, x + w, y + 82, 11, css["--err"], "right", true);
      } else if (n.type === "worker") {
        var cc = Math.min(n.conc, 4), gap = 34, sx = x + 14;
        for (i = 0; i < cc; i++) {
          var cx = sx + i * gap, cy = y + 64, p = n.active[i];
          ctx.beginPath(); ctx.arc(cx, cy, 11, 0, 7); ctx.lineWidth = 2.5; ctx.strokeStyle = css["--line"]; ctx.stroke();
          if (p) { ctx.beginPath(); ctx.arc(cx, cy, 11, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - p.rem / p.tot)); ctx.strokeStyle = col(p.v.color); ctx.lineWidth = 3; ctx.stroke(); ctx.beginPath(); ctx.arc(cx, cy, 4, 0, 7); ctx.fillStyle = col(p.v.color); ctx.fill(); }
        }
        text("処理中 " + n.active.length + "/" + n.conc, x + cc * gap + 6, y + 58, 11, mut, "left", true);
        var bl = n.inbox.length; text("待ち " + bl, x + cc * gap + 6, y + 76, 12, bl > 2 ? css["--err"] : css["--fg"], "left", true, 500);
      } else if (n.type === "lb") {
        var k = n.out.length || 1;
        for (i = 0; i < k; i++) { var on = n.lastEdge === n.out[i] && now - n.lastEdge.flash < 0.5; rr(x + i * 36, y + 56, 30, 14, 4); ctx.fillStyle = on ? c : css["--bg"]; ctx.fill(); }
        text("順番に振り分け", x, y + 84, 11, mut, "left", false);
      } else if (n.type === "fanout") {
        text("全てに複製して配信", x, y + 66, 12, mut, "left", false); text("→ ×" + (n.out.length || 1), x + w, y + 66, 12, c, "right", true, 500);
      } else if (n.type === "filter") {
        text("通過 " + n.st.pass, x, y + 66, 12, css["--info"], "left", true, 500); text((n.beh.dropLabel || "遮断") + " " + n.st.drop, x + w, y + 66, 12, css["--err"], "right", true, 500);
        text("一部は先に進めない", x, y + 84, 11, mut, "left", false);
      } else if (n.type === "batch") {
        var bs = Math.min(n.bsize, 10), bw = (w - (bs - 1) * 3) / bs;
        for (i = 0; i < bs; i++) { rr(x + i * (bw + 3), y + 56, bw, 10, 2); ctx.fillStyle = i < n.items.length ? c : css["--bg"]; ctx.fill(); }
        text(n.bsize + "件たまったら一括送信", x, y + 82, 11, mut, "left", false);
      } else if (n.type === "label") {
        var t = n.beh.text || ""; ctx.font = "500 11px 'IBM Plex Mono',monospace"; var tw = Math.min(w, ctx.measureText(t).width + 16);
        rr(n.cx - tw / 2, y + 56, tw, 20, 10); ctx.fillStyle = c; ctx.fill(); text(t, n.cx, y + 66, 11, css["--bg"], "center", true, 500, tw - 10);
        text("通過する粒に札を付ける", n.cx, y + 88, 10, mut, "center", false);
      }
    }
    function draw() {
      var dpr = window.devicePixelRatio || 1, cw = canvas.clientWidth, ch = Math.round(cw * H / W);
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) { canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); canvas.style.height = ch + "px"; }
      var s = cw / W; ctx.setTransform(dpr * s, 0, 0, dpr * s, 0, 0); ctx.clearRect(0, 0, W, H);
      ctx.globalAlpha = 0.5; ctx.fillStyle = css["--line"]; for (var gx = 15; gx < W; gx += 30) for (var gy = 15; gy < H; gy += 30) ctx.fillRect(gx, gy, 1.4, 1.4); ctx.globalAlpha = 1;
      (spec.columnLabels || []).forEach(function (l, i) { text(l, MX + i * CW + NW / 2, 36, 15, css["--muted"], "center", false, 500, CW - 20); });
      (spec.groups || []).forEach(function (g) {
        var ns = g.nodes.map(function (id) { return nodes[id]; }).filter(Boolean); if (!ns.length) return;
        var x0 = Math.min.apply(null, ns.map(function (n) { return n.x; })) - 22, y0 = Math.min.apply(null, ns.map(function (n) { return n.y; })) - 34;
        var x1 = Math.max.apply(null, ns.map(function (n) { return n.x + NW; })) + 22, y1 = Math.max.apply(null, ns.map(function (n) { return n.y + NH; })) + 20;
        ctx.setLineDash([6, 6]); rr(x0, y0, x1 - x0, y1 - y0, 16); ctx.lineWidth = 1.5; ctx.strokeStyle = css["--line"]; ctx.stroke(); ctx.setLineDash([]);
        text(g.label || "", x0 + 14, y0 + 15, 12, css["--muted"], "left", false, 500);
      });
      ctx.lineWidth = 1.5; ctx.setLineDash([4, 6]);
      edges.forEach(function (e) { ctx.strokeStyle = glow(e.flash, 0.5) > 0 ? css["--fg"] : css["--line"]; ctx.beginPath(); ctx.moveTo(e.a.cx, e.a.cy); ctx.lineTo(e.b.cx, e.b.cy); ctx.stroke(); });
      ctx.setLineDash([]); edges.forEach(drawArrow);
      edges.forEach(function (e) { if (!e.label) return; var mx = (e.a.cx + e.b.cx) / 2, my = (e.a.cy + e.b.cy) / 2; ctx.font = "11px sans-serif"; var tw = ctx.measureText(e.label).width + 12; rr(mx - tw / 2, my - 10, tw, 20, 10); ctx.fillStyle = css["--bg"]; ctx.fill(); text(e.label, mx, my, 11, css["--muted"], "center"); });
      parts.forEach(function (p) {
        if (p.state !== "move") return; var q = pos(p), c = col(p.v.color);
        ctx.save(); ctx.shadowColor = p.hitFx ? css["--info"] : c; ctx.shadowBlur = p.hitFx ? 14 : 8; rr(q[0] - 14, q[1] - 6, 28, 12, 3); ctx.fillStyle = c; ctx.fill(); ctx.restore();
        if (p.hitFx) { rr(q[0] - 14, q[1] - 6, 28, 12, 3); ctx.lineWidth = 2; ctx.strokeStyle = css["--info"]; ctx.stroke(); text("↩", q[0], q[1] - 14, 12, css["--info"], "center", true, 700); }
        else { rr(q[0] - 9, q[1] - 2.5, 12, 2, 1); ctx.fillStyle = "rgba(255,255,255,.85)"; ctx.fill(); rr(q[0] - 9, q[1] + 1, 18, 2, 1); ctx.fillStyle = "rgba(255,255,255,.6)"; ctx.fill(); }
      });
      Object.keys(nodes).forEach(function (id) {
        var n = nodes[id], c = nodeCol(n), g = glow(n.hit, 0.6);
        ctx.save(); if (g > 0) { ctx.shadowColor = c; ctx.shadowBlur = 18 * g; } rr(n.x, n.y, NW, NH, 12); ctx.fillStyle = css["--panel"]; ctx.fill(); ctx.restore();
        rr(n.x, n.y, NW, NH, 12); ctx.lineWidth = 1.5; ctx.strokeStyle = g > 0.05 ? c : css["--line"]; ctx.stroke();
        ctx.beginPath(); ctx.arc(n.x + 16, n.y + 16, 4.5, 0, 7); ctx.fillStyle = c; ctx.fill();
        text((n.type !== "pass" ? n.type : n.d.kind || "").toUpperCase(), n.x + 28, n.y + 16, 10, css["--muted"], "left", true, 500);
        text(n.d.label || n.d.id, n.x + NW / 2, n.y + 31, 15, css["--fg"], "center", false, 700, NW - 20);
        var viz = n.type !== "pass";
        if (n.d.product) {
          ctx.font = "500 11.5px 'IBM Plex Mono',ui-monospace,monospace"; var pw = Math.min(NW - 24, ctx.measureText(n.d.product).width + 20);
          rr(n.cx - pw / 2, n.y + 43, pw, 18, 9); ctx.globalAlpha = 0.16; ctx.fillStyle = c; ctx.fill(); ctx.globalAlpha = 1; ctx.lineWidth = 1; ctx.strokeStyle = c; ctx.stroke();
          text(n.d.product, n.cx, n.y + 52.5, 11.5, css["--fg"], "center", true, 500, NW - 36);
        }
        if (viz) { ctx.save(); ctx.translate(0, 12); drawViz(n, c); ctx.restore(); }
        else if (n.d.counter) text(n.count + " " + n.d.counter, n.x + NW / 2, n.y + 86, 13, c, "center", true, 500, NW - 20);
        else if (n.d.sub && !n.d.product) text(n.d.sub, n.x + NW / 2, n.y + 78, 11, css["--muted"], "center", true, 400, NW - 20);
        if (viz && n.d.counter) text(n.count + " " + n.d.counter, n.x + NW - 12, n.y + 16, 11, c, "right", true, 500);
      });
      parts.forEach(function (p) {
        if (!p.chip || p.state !== "move") return; var q = pos(p), c = col(p.v.color);
        ctx.font = "500 9px 'IBM Plex Mono',monospace"; var w = Math.min(120, ctx.measureText(p.chip).width + 12);
        rr(q[0] - w / 2, q[1] + 9, w, 13, 6.5); ctx.fillStyle = c; ctx.fill(); text(p.chip, q[0], q[1] + 15.5, 9, css["--bg"], "center", true, 500, w - 8);
      });
      fx.forEach(function (f) { var a = 1 - (now - f.t) / 0.9; ctx.globalAlpha = a; text(f.s, f.x, f.y - (1 - a) * 30 - 6, 34, css["--err"], "center", false, 700); ctx.globalAlpha = 1; });
      if (loadMul > 1) text("負荷 ×" + loadMul, W - 20, 36, 15, css["--err"], "right", true, 700);
    }
    function frame(ts) {
      if (!last) last = ts; var dt = Math.min(0.05, (ts - last) / 1000); last = ts;
      if (!paused) update(dt * speed); draw(); raf = requestAnimationFrame(frame);
    }
    readCss();
    for (var i = 0; i < 300; i++) update(1 / 30);
    var mo = new MutationObserver(readCss); mo.observe(document.documentElement, { attributes: true });
    var mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)"); if (mq && mq.addEventListener) mq.addEventListener("change", readCss);
    raf = requestAnimationFrame(frame);
    var zf = 1, fitBox = null, ro = null;
    function fitNow() {
      if (!fitBox) return; var cw = fitBox.clientWidth; if (!cw) return;
      var top = Math.max(0, fitBox.getBoundingClientRect().top), availH = Math.max(280, window.innerHeight - top - 28);
      var sc = Math.max(0.5, Math.min(1.5, Math.min((cw - 2) / W, availH / H))) * zf;
      canvas.style.width = Math.round(W * sc) + "px"; canvas.style.height = Math.round(H * sc) + "px";
    }
    function onResize() { fitNow(); }
    return {
      size: { w: W, h: H },
      autoFit: function (box) { fitBox = box; canvas.style.margin = "0 auto"; fitNow(); window.addEventListener("resize", onResize); if (window.ResizeObserver) { ro = new ResizeObserver(fitNow); ro.observe(box); } },
      refit: fitNow, zoomBy: function (f) { zf = Math.max(0.4, Math.min(2.5, zf * f)); fitNow(); }, zoomReset: function () { zf = 1; fitNow(); },
      setPaused: function (p) { paused = p; }, isPaused: function () { return paused; }, setSpeed: function (v) { speed = v; },
      burst: function () { loadMul = 4; loadUntil = now + 10; },
      destroy: function () { cancelAnimationFrame(raf); mo.disconnect(); window.removeEventListener("resize", onResize); if (ro) ro.disconnect(); }
    };
  }
  root.ArchFlow = ArchFlow;
})(window);
