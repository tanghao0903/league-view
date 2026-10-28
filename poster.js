/* 独立 Canvas 海报绘制器：输入统一的领域结果，页面预览与 JPG 导出共用同一张画布。 */
(function () {
  "use strict";

  const FONT = '"Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Noto Sans SC","Source Han Sans SC","WenQuanYi Zen Hei",sans-serif';
  const W = 1080;
  const C = {
    purple: "#360046",
    light: "#fbfafc",
    muted: "#7a7287",
    line: "#e3dde9",
    lime: "#ceff48",
    darkA: "#241a2f",
    darkB: "#17161c",
    avatarBg: ["#e4e2f7", "#e6f2d2"],
    avatarInk: ["#2e2a80", "#3c5200"],
  };

  function font(size, weight) {
    return `${weight || 400} ${size}px ${FONT}`;
  }

  function setSpacing(ctx, px) {
    if ("letterSpacing" in ctx) ctx.letterSpacing = px + "px";
  }

  /* 缩小字号直到放得下；返回字号 */
  function fitSize(ctx, text, maxW, start, min, weight) {
    let size = start;
    while (size > min) {
      ctx.font = font(size, weight);
      if (ctx.measureText(text).width <= maxW) return size;
      size -= 2;
    }
    ctx.font = font(min, weight);
    return min;
  }

  /* 按字符换行（中文友好），不截断 */
  function wrap(ctx, text, maxW) {
    const lines = [];
    let cur = "";
    for (const ch of Array.from(text)) {
      const next = cur + ch;
      if (cur && ctx.measureText(next).width > maxW) {
        lines.push(cur);
        cur = ch;
      } else {
        cur = next;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  /* 行数不变的前提下尽量让各行等长 */
  function balancedWrap(ctx, text, maxW) {
    const lines = wrap(ctx, text, maxW);
    let w = maxW;
    let best = lines;
    while (w > 40) {
      w -= 4;
      const trial = wrap(ctx, text, w);
      if (trial.length > lines.length) break;
      best = trial;
    }
    return best;
  }

  /* 名字：先缩字号，仍放不下则在给定高度内换行，不截字 */
  function drawName(ctx, text, x, cy, maxW, align, color, start, maxH) {
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    const size = fitSize(ctx, text, maxW, start, 24, 700);
    ctx.font = font(size, 700);
    if (ctx.measureText(text).width <= maxW) {
      ctx.fillText(text, x, cy);
      return;
    }
    const limit = maxH || 120;
    let lines = [];
    let sz = 26;
    for (; sz >= 16; sz -= 2) {
      ctx.font = font(sz, 700);
      lines = balancedWrap(ctx, text, maxW);
      if (lines.length * sz * 1.18 <= limit) break;
    }
    const lh = sz * 1.18;
    const top = cy - ((lines.length - 1) * lh) / 2;
    lines.forEach((ln, i) => ctx.fillText(ln, x, top + i * lh));
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawAvatar(ctx, p, idx, x, y, size, dark) {
    ctx.save();
    roundRect(ctx, x, y, size, size, size * 0.22);
    ctx.clip();
    if (p.image) {
      const img = p.image;
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, x, y, size, size);
    } else {
      ctx.fillStyle = dark ? "#3a3342" : C.avatarBg[idx];
      ctx.fillRect(x, y, size, size);
      ctx.fillStyle = dark ? "#ffffff" : C.avatarInk[idx];
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = font(Math.round(size * 0.46), 800);
      ctx.fillText(initial(p.nickname, idx), x + size / 2, y + size / 2 + 1);
    }
    ctx.restore();
  }

  function initial(name, idx) {
    const s = String(name || "").trim();
    if (!s) return idx === 0 ? "A" : "B";
    const m = s.match(/[A-Za-z0-9]/);
    // 形如“用户A”取字母；中文名取第一个字
    if (/^用户/.test(s) && m) return m[0].toUpperCase();
    return Array.from(s)[0].toUpperCase();
  }

  function loadImages(participants) {
    return Promise.all(participants.map((p) => new Promise((resolve) => {
      if (!p.avatar) return resolve(Object.assign({}, p, { image: null }));
      const img = new Image();
      img.onload = () => resolve(Object.assign({}, p, { image: img }));
      img.onerror = () => resolve(Object.assign({}, p, { image: null }));
      img.src = p.avatar;
    })));
  }

  async function ready() {
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (e) { /* 忽略 */ }
    }
  }

  function cellText(cell) {
    if (!cell || cell.status === "pending") return "—";
    if (cell.status === "absent") return "缺考";
    return cell.value;
  }

  /* ---------- 学科比分海报（参考图一：浅底、深紫标题与比分块） ---------- */
  async function drawScorePoster(canvas, d) {
    await ready();
    const people = await loadImages(d.participants);
    const pad = 96;
    const inner = W - pad * 2;
    const rows = d.rows;
    const rowH = 214;
    const headH = 360;
    const footH = 190;
    const H = Math.max(rows.length > 1 ? 1350 : 0, headH + 20 + rows.length * rowH + footH);
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = C.light;
    ctx.fillRect(0, 0, W, H);

    // 顶部
    let y = 92;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = C.purple;
    ctx.font = font(22, 800);
    setSpacing(ctx, 6);
    ctx.fillText(d.kicker, pad, y);
    setSpacing(ctx, 0);

    y += 118;
    const tSize = fitSize(ctx, d.title, inner, 108, 56, 900);
    ctx.font = font(tSize, 900);
    ctx.fillText(d.title, pad, y);

    y += 34;
    ctx.font = font(28, 700);
    const tagW = ctx.measureText(d.tag).width + 52;
    ctx.fillStyle = C.purple;
    roundRect(ctx, pad, y, tagW, 58, 12);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    ctx.fillText(d.tag, pad + 26, y + 30);
    if (d.multiplierBadge) {
      ctx.font = font(28, 800);
      const bw = ctx.measureText(d.multiplierBadge).width + 40;
      ctx.fillStyle = C.lime;
      roundRect(ctx, pad + tagW + 14, y, bw, 58, 12);
      ctx.fill();
      ctx.fillStyle = "#1d2600";
      ctx.fillText(d.multiplierBadge, pad + tagW + 34, y + 30);
    }

    y += 100;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = C.muted;
    ctx.font = font(26, 400);
    ctx.fillText(d.metaLine, pad, y);

    // 统一比分块宽度，保证四行对齐
    ctx.font = font(64, 800);
    let boxW = 250;
    rows.forEach((r) => {
      const t = `${cellText(r.cells[0])} : ${cellText(r.cells[1])}`;
      boxW = Math.max(boxW, ctx.measureText(t).width + 72);
    });
    const cx = W / 2;
    const avatarSize = 72;
    const gapA = 26;
    const nameGap = 20;

    y = headH + 20;
    rows.forEach((r) => {
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(W - pad, y);
      ctx.stroke();

      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      ctx.fillStyle = C.purple;
      ctx.font = font(30, 800);
      ctx.fillText(r.subject, pad, y + 54);
      ctx.textAlign = "right";
      ctx.fillStyle = C.muted;
      ctx.font = font(22, 400);
      ctx.fillText(r.meta, W - pad, y + 52);

      const midY = y + 124;
      const boxH = 92;
      const bx = cx - boxW / 2;
      ctx.fillStyle = C.purple;
      roundRect(ctx, bx, midY - boxH / 2, boxW, boxH, 14);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const scoreText = `${cellText(r.cells[0])} : ${cellText(r.cells[1])}`;
      ctx.font = font(fitSize(ctx, scoreText, boxW - 40, 64, 36, 800), 800);
      ctx.fillText(scoreText, cx, midY + 3);
      ctx.fillStyle = C.muted;
      ctx.font = font(20, 400);
      ctx.fillText(r.caption, cx, midY + boxH / 2 + 22);

      const ax = bx - gapA - avatarSize;
      const bx2 = bx + boxW + gapA;
      drawAvatar(ctx, people[0], 0, ax, midY - avatarSize / 2, avatarSize, false);
      drawAvatar(ctx, people[1], 1, bx2, midY - avatarSize / 2, avatarSize, false);
      const nameMax = ax - nameGap - pad;
      drawName(ctx, people[0].nickname, ax - nameGap, midY, nameMax, "right", C.purple, 34, 100);
      drawName(ctx, people[1].nickname, bx2 + avatarSize + nameGap, midY, nameMax, "left", C.purple, 34, 100);

      y += rowH;
    });

    // 页脚
    const fy = H - footH + 30;
    ctx.fillStyle = C.lime;
    roundRect(ctx, pad, fy, inner, 84, 18);
    ctx.fill();
    ctx.fillStyle = "#1d2600";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.font = font(26, 800);
    ctx.fillText(d.projectTitle, pad + 30, fy + 43);
    ctx.textAlign = "right";
    ctx.font = font(24, 700);
    ctx.fillText(d.slogan, W - pad - 30, fy + 43);
    ctx.fillStyle = C.muted;
    ctx.textAlign = "center";
    ctx.font = font(20, 400);
    ctx.fillText(d.footnote, W / 2, fy + 130);
    return canvas;
  }

  /* ---------- 用户积分榜（参考图二：深底、荧光绿细边框） ---------- */
  async function drawBoardPoster(canvas, d) {
    await ready();
    const people = await loadImages(d.participants);
    const byId = {};
    people.forEach((p, i) => { byId[p.id] = { p, idx: i }; });
    const pad = 80;
    const inner = W - pad * 2;
    const H = 1350;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");

    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, C.darkA);
    g.addColorStop(1, C.darkB);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // 抽象背景：细斜线纹理
    ctx.save();
    ctx.strokeStyle = "rgba(206,255,72,0.05)";
    ctx.lineWidth = 2;
    for (let i = -H; i < W; i += 46) {
      ctx.beginPath();
      ctx.moveTo(i, H);
      ctx.lineTo(i + H * 0.6, 0);
      ctx.stroke();
    }
    ctx.restore();

    let y = 96;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = C.lime;
    ctx.font = font(22, 800);
    setSpacing(ctx, 6);
    ctx.fillText(d.kicker, pad, y);
    setSpacing(ctx, 0);

    ctx.fillStyle = "#ffffff";
    y += 104;
    ctx.font = font(fitSize(ctx, d.title1, inner, 84, 48, 900), 900);
    ctx.fillText(d.title1, pad, y);
    y += 104;
    ctx.font = font(fitSize(ctx, d.title2, inner, 84, 48, 900), 900);
    ctx.fillText(d.title2, pad, y);
    y += 56;
    ctx.fillStyle = "#b9b2c6";
    ctx.font = font(26, 400);
    ctx.fillText(d.scopeLine, pad, y);

    y += 84;
    ctx.fillStyle = "#ffffff";
    ctx.font = font(30, 800);
    ctx.fillText(d.sectionTitle, pad, y);
    ctx.textAlign = "right";
    ctx.fillStyle = "#b9b2c6";
    ctx.font = font(22, 400);
    ctx.fillText(`${d.rows.length} 位参赛者`, W - pad, y);

    // 榜单
    y += 26;
    const headRow = 72;
    const rowH = 128;
    const tableH = headRow + rowH * d.rows.length;
    ctx.fillStyle = "rgba(255,255,255,0.045)";
    roundRect(ctx, pad, y, inner, tableH, 28);
    ctx.fill();
    ctx.strokeStyle = C.lime;
    ctx.lineWidth = 2;
    roundRect(ctx, pad + 1, y + 1, inner - 2, tableH - 2, 28);
    ctx.stroke();

    const colRank = pad + 64;
    const colAvatar = pad + 128;
    const colThis = W - pad - 250;
    const colCum = W - pad - 44;
    ctx.fillStyle = "#a9a1b7";
    ctx.font = font(22, 400);
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText("名次", colRank, y + headRow / 2);
    ctx.textAlign = "left";
    ctx.fillText("用户", colAvatar, y + headRow / 2);
    ctx.textAlign = "right";
    ctx.fillText(d.thisHeader, colThis, y + headRow / 2);
    ctx.fillText("累计", colCum, y + headRow / 2);

    let ry = y + headRow;
    d.rows.forEach((r) => {
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pad + 2, ry);
      ctx.lineTo(W - pad - 2, ry);
      ctx.stroke();
      const mid = ry + rowH / 2;
      const info = byId[r.participant_id];
      ctx.textAlign = "center";
      ctx.fillStyle = r.rank === 1 ? C.lime : "#a9a1b7";
      ctx.font = font(46, 300);
      ctx.fillText(String(r.rank), colRank, mid + (r.tied ? -10 : 2));
      if (r.tied) {
        ctx.font = font(18, 700);
        ctx.fillText("并列", colRank, mid + 34);
      }
      drawAvatar(ctx, info.p, info.idx, colAvatar, mid - 34, 68, true);
      const nameX = colAvatar + 68 + 22;
      ctx.font = font(36, 800);
      drawName(ctx, info.p.nickname, nameX, mid, colThis - 120 - nameX, "left", "#ffffff", 36, 104);
      ctx.textAlign = "right";
      ctx.fillStyle = "#d9d3e2";
      ctx.font = font(fitSize(ctx, r.thisText, 150, 36, 22, 400), 400);
      ctx.fillText(r.thisText, colThis, mid + 2);
      ctx.fillStyle = "#ffffff";
      ctx.font = font(fitSize(ctx, r.cumText, 190, 68, 36, 900), 900);
      ctx.fillText(r.cumText, colCum, mid + 4);
      ry += rowH;
    });

    // 下半区
    let by = y + tableH + 120;
    const bigW = 460;
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = C.lime;
    const bigSize = fitSize(ctx, d.bigLabel, bigW, 240, 90, 900);
    ctx.font = font(bigSize, 900);
    ctx.fillText(d.bigLabel, W - pad, by + 150);

    ctx.textAlign = "left";
    ctx.fillStyle = "#ece4f4";
    ctx.font = font(52, 900);
    ctx.fillText("下一次交锋，", pad, by + 20);
    ctx.fillText("由你改写排名。", pad, by + 88);
    ctx.fillStyle = "#b9b2c6";
    ctx.font = font(22, 400);
    ctx.fillText("常规周测 + 特殊考试", pad, by + 140);
    ctx.fillText("A / C 各自累计、各自排名，互不相加。", pad, by + 174);

    const fy = H - 110;
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pad, fy);
    ctx.lineTo(W - pad, fy);
    ctx.stroke();
    ctx.fillStyle = "#b9b2c6";
    ctx.font = font(20, 400);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(d.footLeft, pad, fy + 44);
    ctx.textAlign = "right";
    ctx.fillText(d.footRight, W - pad, fy + 44);
    return canvas;
  }

  /* ---------- 单场战报（浅底标题 + 深紫对阵块 + 学科明细 + 深色战后积分榜） ---------- */
  async function drawReportPoster(canvas, d) {
    await ready();
    const people = await loadImages(d.participants);
    const pad = 80;
    const inner = W - pad * 2;
    const subjRowH = 104;
    const vsH = 380;
    const standRowH = 200;
    const H = 360 + vsH + 60 + 64 + d.subjects.length * subjRowH + 70 + 90 + standRowH * d.standings.length + 210;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = C.light;
    ctx.fillRect(0, 0, W, H);

    // 顶部
    let y = 92;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = C.purple;
    ctx.font = font(22, 800);
    setSpacing(ctx, 6);
    ctx.fillText(d.kicker, pad, y);
    setSpacing(ctx, 0);
    y += 118;
    ctx.font = font(fitSize(ctx, d.title, inner, 108, 56, 900), 900);
    ctx.fillText(d.title, pad, y);
    y += 34;
    ctx.font = font(28, 700);
    const tagW = ctx.measureText(d.tag).width + 52;
    roundRect(ctx, pad, y, tagW, 58, 12);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    ctx.fillText(d.tag, pad + 26, y + 30);
    if (d.multiplierBadge) {
      ctx.font = font(28, 800);
      const bw = ctx.measureText(d.multiplierBadge).width + 40;
      ctx.fillStyle = C.lime;
      roundRect(ctx, pad + tagW + 14, y, bw, 58, 12);
      ctx.fill();
      ctx.fillStyle = "#1d2600";
      ctx.fillText(d.multiplierBadge, pad + tagW + 34, y + 30);
    }
    y += 100;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = C.muted;
    ctx.font = font(26, 400);
    ctx.fillText(d.metaLine, pad, y);

    // “比分”两边对齐：左数右对齐、冒号居中、右数左对齐
    function pair(vals, cx, cy, size, weight, colors, gap) {
      ctx.textBaseline = "middle";
      ctx.font = font(size, weight);
      ctx.textAlign = "center";
      ctx.fillStyle = colors[2];
      ctx.fillText(":", cx, cy);
      ctx.textAlign = "right";
      ctx.fillStyle = colors[0];
      ctx.fillText(vals[0], cx - gap, cy);
      ctx.textAlign = "left";
      ctx.fillStyle = colors[1];
      ctx.fillText(vals[1], cx + gap, cy);
    }

    // 对阵块：本场 A / C 积分
    y = 360;
    ctx.fillStyle = C.purple;
    roundRect(ctx, pad, y, inner, vsH, 28);
    ctx.fill();
    const av = 88;
    drawAvatar(ctx, people[0], 0, pad + 40, y + 40, av, true);
    drawAvatar(ctx, people[1], 1, W - pad - 40 - av, y + 40, av, true);
    const nameMax = inner / 2 - 40 - av - 24 - 60;
    drawName(ctx, people[0].nickname, pad + 40 + av + 22, y + 40 + av / 2, nameMax, "left", "#ffffff", 36, 90);
    drawName(ctx, people[1].nickname, W - pad - 40 - av - 22, y + 40 + av / 2, nameMax, "right", "#ffffff", 36, 90);
    ctx.fillStyle = C.lime;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = font(34, 900);
    ctx.fillText("VS", W / 2, y + 40 + av / 2);
    const lineY = [y + 196, y + 286];
    d.thisLines.forEach((ln, i) => {
      const cy = lineY[i];
      ctx.textAlign = "left";
      ctx.fillStyle = "#cfc4dc";
      ctx.font = font(24, 700);
      ctx.fillText(ln.label, pad + 40, cy);
      const hi = (k) => (ln.winner === k ? C.lime : "#ffffff");
      pair(ln.values, W / 2 + 40, cy + 2, 66, 900, [hi(0), hi(1), "#9d8fb0"], 30);
      ctx.textAlign = "right";
      ctx.fillStyle = ln.winner == null ? "#cfc4dc" : C.lime;
      ctx.font = font(24, 700);
      ctx.fillText(ln.verdict, W - pad - 40, cy);
    });

    // 学科明细
    y += vsH + 60;
    const colName = pad;
    const colScore = pad + 380;
    const colA = pad + 640;
    const colC = W - pad - 110;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = C.purple;
    ctx.font = font(30, 800);
    ctx.textAlign = "left";
    ctx.fillText("四科交锋", colName, y + 6);
    ctx.fillStyle = C.muted;
    ctx.font = font(22, 400);
    ctx.textAlign = "center";
    ctx.fillText("原始分数", colScore, y + 6);
    ctx.fillText("A 分差", colA, y + 6);
    ctx.fillText("C 联赛", colC, y + 6);
    y += 28;
    d.subjects.forEach((r) => {
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(W - pad, y);
      ctx.stroke();
      const cy = y + subjRowH / 2;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = C.purple;
      ctx.font = font(32, 800);
      ctx.fillText(r.name, colName, cy - 14);
      ctx.fillStyle = C.muted;
      ctx.font = font(19, 400);
      ctx.fillText(r.meta, colName, cy + 22);
      const hi = (k) => (r.winner === k ? C.purple : C.muted);
      pair([cellText(r.cells[0]), cellText(r.cells[1])], colScore, cy + 2, 44, 800, [hi(0), hi(1), C.muted], 20);
      pair(r.a, colA, cy + 2, 34, 700, [hi(0), hi(1), C.muted], 16);
      pair(r.c, colC, cy + 2, 34, 700, [hi(0), hi(1), C.muted], 16);
      y += subjRowH;
    });
    ctx.strokeStyle = C.line;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(W - pad, y);
    ctx.stroke();

    // 战后积分榜
    y += 70;
    const boxH = 90 + standRowH * d.standings.length;
    const g = ctx.createLinearGradient(0, y, W, y + boxH);
    g.addColorStop(0, C.darkA);
    g.addColorStop(1, C.darkB);
    ctx.fillStyle = g;
    roundRect(ctx, pad, y, inner, boxH, 28);
    ctx.fill();
    ctx.strokeStyle = C.lime;
    ctx.lineWidth = 2;
    roundRect(ctx, pad + 1, y + 1, inner - 2, boxH - 2, 28);
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffffff";
    ctx.font = font(30, 800);
    ctx.fillText("战后积分榜", pad + 40, y + 52);
    ctx.textAlign = "right";
    ctx.fillStyle = "#b9b2c6";
    ctx.font = font(22, 400);
    ctx.fillText(d.standingsNote, W - pad - 40, y + 52);
    let sy = y + 90;
    d.standings.forEach((st) => {
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pad + 2, sy);
      ctx.lineTo(W - pad - 2, sy);
      ctx.stroke();
      ctx.textAlign = "left";
      ctx.fillStyle = C.lime;
      ctx.font = font(24, 800);
      ctx.fillText(st.label, pad + 40, sy + 44);
      const lead = (k) => (st.leader === k ? C.lime : "#ffffff");
      pair(st.after, W / 2, sy + 104, 72, 900, [lead(0), lead(1), "#6f6680"], 34);
      ctx.fillStyle = "#b9b2c6";
      ctx.font = font(22, 400);
      ctx.textAlign = "right";
      ctx.fillText(st.delta[0], W / 2 - 34, sy + 156);
      ctx.textAlign = "left";
      ctx.fillText(st.delta[1], W / 2 + 34, sy + 156);
      ctx.textAlign = "right";
      ctx.fillStyle = "#ece4f4";
      ctx.font = font(fitSize(ctx, st.story, 380, 24, 18, 700), 700);
      ctx.fillText(st.story, W - pad - 40, sy + 44);
      sy += standRowH;
    });

    // 页脚
    const fy = H - 180;
    ctx.fillStyle = C.lime;
    roundRect(ctx, pad, fy, inner, 84, 18);
    ctx.fill();
    ctx.fillStyle = "#1d2600";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.font = font(26, 800);
    ctx.fillText(d.projectTitle, pad + 30, fy + 43);
    ctx.textAlign = "right";
    ctx.font = font(24, 700);
    ctx.fillText(d.slogan, W - pad - 30, fy + 43);
    ctx.fillStyle = C.muted;
    ctx.textAlign = "center";
    ctx.font = font(20, 400);
    ctx.fillText(d.footnote, W / 2, fy + 130);
    return canvas;
  }

  /* ---------- 单科战报：一科一张（大比分 + 本科 A/C 积分 + 战前累计） ---------- */
  async function drawSubjectPoster(canvas, d) {
    await ready();
    const people = await loadImages(d.participants);
    const pad = 80;
    const inner = W - pad * 2;
    const vsH = 400;
    const cardH = 250;
    const bandH = 96;
    const H = 360 + vsH + 40 + cardH + 36 + bandH + 60 + 180;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = C.light;
    ctx.fillRect(0, 0, W, H);

    let y = 92;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = C.purple;
    ctx.font = font(22, 800);
    setSpacing(ctx, 6);
    ctx.fillText(d.kicker, pad, y);
    setSpacing(ctx, 0);
    y += 118;
    ctx.font = font(fitSize(ctx, d.title, inner, 108, 56, 900), 900);
    ctx.fillText(d.title, pad, y);
    y += 34;
    ctx.font = font(28, 700);
    const tagW = ctx.measureText(d.tag).width + 52;
    roundRect(ctx, pad, y, tagW, 58, 12);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    ctx.fillText(d.tag, pad + 26, y + 30);
    if (d.multiplierBadge) {
      ctx.font = font(28, 800);
      const bw = ctx.measureText(d.multiplierBadge).width + 40;
      ctx.fillStyle = C.lime;
      roundRect(ctx, pad + tagW + 14, y, bw, 58, 12);
      ctx.fill();
      ctx.fillStyle = "#1d2600";
      ctx.fillText(d.multiplierBadge, pad + tagW + 34, y + 30);
    }
    y += 100;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = C.muted;
    ctx.font = font(26, 400);
    ctx.fillText(d.metaLine, pad, y);

    // 对阵块：原始分数
    y = 360;
    ctx.fillStyle = C.purple;
    roundRect(ctx, pad, y, inner, vsH, 28);
    ctx.fill();
    const av = 88;
    drawAvatar(ctx, people[0], 0, pad + 40, y + 40, av, true);
    drawAvatar(ctx, people[1], 1, W - pad - 40 - av, y + 40, av, true);
    const nameMax = inner / 2 - 40 - av - 24 - 60;
    drawName(ctx, people[0].nickname, pad + 40 + av + 22, y + 40 + av / 2, nameMax, "left", "#ffffff", 36, 90);
    drawName(ctx, people[1].nickname, W - pad - 40 - av - 22, y + 40 + av / 2, nameMax, "right", "#ffffff", 36, 90);
    ctx.fillStyle = C.lime;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = font(34, 900);
    ctx.fillText("VS", W / 2, y + 40 + av / 2);
    const cy = y + 238;
    const hi = (k) => (d.winner === k ? C.lime : "#ffffff");
    const vals = [cellText(d.cells[0]), cellText(d.cells[1])];
    ctx.font = font(132, 900);
    const gap = 44;
    ctx.fillStyle = "#9d8fb0";
    ctx.fillText(":", W / 2, cy);
    ctx.textAlign = "right";
    ctx.fillStyle = hi(0);
    ctx.font = font(fitSize(ctx, vals[0], inner / 2 - 80, 132, 60, 900), 900);
    ctx.fillText(vals[0], W / 2 - gap, cy + 4);
    ctx.textAlign = "left";
    ctx.fillStyle = hi(1);
    ctx.font = font(fitSize(ctx, vals[1], inner / 2 - 80, 132, 60, 900), 900);
    ctx.fillText(vals[1], W / 2 + gap, cy + 4);
    ctx.textAlign = "center";
    ctx.fillStyle = d.winner == null ? "#cfc4dc" : C.lime;
    ctx.font = font(28, 800);
    ctx.fillText(d.verdict, W / 2, y + vsH - 52);

    // 本科积分：A / C 两张卡
    y += vsH + 40;
    const cardW = (inner - 24) / 2;
    d.points.forEach((pt, i) => {
      const x = pad + i * (cardW + 24);
      ctx.fillStyle = "#ffffff";
      roundRect(ctx, x, y, cardW, cardH, 24);
      ctx.fill();
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 2;
      roundRect(ctx, x + 1, y + 1, cardW - 2, cardH - 2, 24);
      ctx.stroke();
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = C.purple;
      ctx.font = font(26, 800);
      ctx.fillText(pt.label, x + 32, y + 46);
      const mid = x + cardW / 2;
      ctx.font = font(72, 900);
      ctx.textAlign = "center";
      ctx.fillStyle = C.muted;
      ctx.fillText(":", mid, y + 128);
      const col = (k) => (pt.winner === k ? C.purple : "#b1a9bb");
      ctx.textAlign = "right";
      ctx.fillStyle = col(0);
      ctx.fillText(pt.values[0], mid - 24, y + 130);
      ctx.textAlign = "left";
      ctx.fillStyle = col(1);
      ctx.fillText(pt.values[1], mid + 24, y + 130);
      ctx.textAlign = "center";
      ctx.fillStyle = C.muted;
      ctx.font = font(fitSize(ctx, pt.note, cardW - 48, 21, 16, 400), 400);
      ctx.fillText(pt.note, mid, y + 206);
    });

    // 战前累计
    y += cardH + 36;
    const g = ctx.createLinearGradient(0, y, W, y + bandH);
    g.addColorStop(0, C.darkA);
    g.addColorStop(1, C.darkB);
    ctx.fillStyle = g;
    roundRect(ctx, pad, y, inner, bandH, 22);
    ctx.fill();
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = C.lime;
    ctx.font = font(22, 800);
    ctx.fillText(d.beforeTitle, pad + 32, y + bandH / 2);
    ctx.textAlign = "right";
    ctx.fillStyle = "#ffffff";
    ctx.font = font(fitSize(ctx, d.beforeLine, inner - 300, 28, 18, 700), 700);
    ctx.fillText(d.beforeLine, W - pad - 32, y + bandH / 2);

    const fy = H - 180;
    ctx.fillStyle = C.lime;
    roundRect(ctx, pad, fy, inner, 84, 18);
    ctx.fill();
    ctx.fillStyle = "#1d2600";
    ctx.textAlign = "left";
    ctx.font = font(26, 800);
    ctx.fillText(d.projectTitle, pad + 30, fy + 43);
    ctx.textAlign = "right";
    ctx.font = font(24, 700);
    ctx.fillText(d.slogan, W - pad - 30, fy + 43);
    ctx.fillStyle = C.muted;
    ctx.textAlign = "center";
    ctx.font = font(fitSize(ctx, d.footnote, inner, 20, 16, 400), 400);
    ctx.fillText(d.footnote, W / 2, fy + 130);
    return canvas;
  }

  function toJpeg(canvas) {
    // 画布已整体绘制不透明背景；质量 0.95
    return canvas.toDataURL("image/jpeg", 0.95);
  }

  window.Poster = { drawScorePoster, drawBoardPoster, drawReportPoster, drawSubjectPoster, toJpeg, initial,
    util: { W, C, FONT, font, fitSize, setSpacing, roundRect, drawAvatar, drawName, loadImages, ready } };
})();
