/* 学术军备竞赛（冷战版）前端：所有正式数据来自本地服务（SQLite），浏览器只记住界面偏好。 */
(function () {
  "use strict";

  const SUBJECTS = [
    { code: "math", name: "数学" },
    { code: "english", name: "英语" },
    { code: "physics", name: "物理" },
    { code: "chemistry", name: "化学" },
  ];
  const SYS_NAME = { A: "A 分差积分", C: "C 联赛积分" };
  const BOARD_NAME = { A: "A 分差积分榜", C: "C 联赛积分榜" };
  const STATUS_CHIP = {
    draft: ["draft", "草稿 · 未结算"],
    settled: ["ok", "已结算"],
    dirty: ["warn", "有未结算修改"],
  };

  // 只读看板（发布给朋友的网页）：数据来自同目录的 data.json 快照，没有任何写入功能
  const RO = !!window.LEAGUE_READONLY;
  const view = document.getElementById("view");
  let APP = null; // /api/state
  let saveChain = Promise.resolve();

  // ---------- 工具 ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function pref(key, value) {
    try {
      if (value === undefined) return localStorage.getItem("al." + key);
      localStorage.setItem("al." + key, value);
    } catch (e) { /* 浏览器存储不可用时忽略，只影响界面偏好 */ }
    return null;
  }

  // 累计榜快照（data.json）与单场战报（reports.json）分开发布，各自读取；任一个不存在都不影响另一个
  const roFiles = {};
  async function readonlyFile(name, fallback) {
    const cur = roFiles[name];
    if (cur && Date.now() - cur.at < 120000) return cur.data;
    let res;
    try {
      res = await fetch(name + "?t=" + Date.now(), { cache: "no-store" });
    } catch (e) {
      if (cur) return cur.data;
      throw new Error("网络连接失败，请稍后刷新。");
    }
    const data = res.ok ? await res.json() : fallback;
    roFiles[name] = { data, at: Date.now() };
    return data;
  }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  // reports.json 里一份份战报（单科 / 整场）按考试归组，形状与本地服务的 /reports 一致
  function groupReports(list) {
    const byId = new Map();
    list.forEach((r) => {
      const e = r.event;
      if (!byId.has(r.id)) {
        byId.set(r.id, {
          id: r.id, label: e.label, kind: e.kind, name: e.name, exam_date: e.exam_date, multiplier: e.multiplier,
          status: "published", settled: false, totals: null, exam: { published: null },
          subjects: SUBJECTS.map((s) => ({ code: s.code, name: s.name, ready: false, published: null })),
        });
      }
      const it = byId.get(r.id);
      if (r.subject) {
        const s = it.subjects.find((x) => x.code === r.subject);
        Object.assign(s, { ready: true, published: { at: r.published_at }, a: r.result.a, c: r.result.c, winner: r.result.winner });
      } else {
        Object.assign(it, { settled: true, totals: r.totals, exam: { published: { at: r.published_at } } });
      }
    });
    return Array.from(byId.values());
  }
  async function readonlyApi(method, path) {
    if (method !== "GET") throw new Error("这是只读看板，不能修改数据。");
    if (path === "/materials") return clone(await readonlyFile("materials.json", { items: [], collect_url: "", collect_note: "" }));
    if (path === "/reports" || path.startsWith("/report/")) {
      const rp = await readonlyFile("reports.json", { reports: [] });
      if (path === "/reports") return { items: groupReports(rp.reports) };
      const [, , id, sub] = path.split("/");
      const r = rp.reports.find((x) => String(x.id) === id && (x.subject || "") === (sub || ""));
      if (!r) throw new Error("这份战报没有发布，或者已经撤下了。");
      return clone(r);
    }
    const snap = await readonlyFile("data.json", null);
    if (path === "/state" && !(snap && snap.responses["/state"])) {
      // 只发布过战报、还没发布累计榜：用战报文件里的昵称和头像
      const rp = await readonlyFile("reports.json", { reports: [] });
      if (rp.state) return clone(rp.state);
      throw new Error("还没有发布任何成绩。");
    }
    const data = snap && snap.responses[path];
    if (data === undefined) throw new Error("这部分内容还没有发布。");
    return clone(data);
  }

  async function api(method, path, body) {
    if (RO) return readonlyApi(method, path);
    const opt = { method, headers: {} };
    if (body !== undefined) {
      opt.headers["Content-Type"] = "application/json";
      opt.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch("/api" + path, opt);
    } catch (e) {
      const err = new Error("无法连接本地服务，请确认启动窗口没有关闭。");
      err.network = true;
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `请求失败（${res.status}）`);
      err.field = data.field;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(msg, isErr) {
    const el = document.createElement("div");
    el.className = "toast" + (isErr ? " err" : "");
    el.textContent = msg;
    $("#toasts").appendChild(el);
    setTimeout(() => el.remove(), isErr ? 6000 : 3500);
  }

  function signed(v) {
    if (v == null) return "—";
    return (String(v).startsWith("-") ? "" : "+") + v;
  }

  function people() { return APP.participants; }
  function nick(pid) {
    const p = APP.participants.find((x) => x.id === Number(pid));
    return p ? p.nickname : "?";
  }
  function avatarHtml(p, idx, cls) {
    const inner = p.avatar ? `<img src="${esc(p.avatar)}" alt="">` : esc(window.Poster.initial(p.nickname, idx));
    return `<div class="avatar ${idx === 1 ? "p1" : ""} ${cls || ""}">${inner}</div>`;
  }

  function eventOptionLabel(ev) {
    const kind = ev.kind === "weekly" ? "常规周测" : `特殊考试 ×${ev.multiplier}`;
    const st = { draft: "未结算", settled: "已结算", dirty: "有修改" }[ev.status];
    return `${ev.label} · ${kind} · ${ev.exam_date} · ${st}`;
  }
  function eventsNewestFirst() {
    return APP.events.slice().sort((a, b) => b.order_index - a.order_index);
  }
  function findEvent(id) { return APP.events.find((e) => e.id === Number(id)); }
  function defaultEventId() {
    const saved = Number(pref("event"));
    if (saved && findEvent(saved)) return saved;
    const list = eventsNewestFirst();
    return list.length ? list[0].id : null;
  }
  function eventSelect(id, current) {
    const opts = eventsNewestFirst().map((ev) => `<option value="${ev.id}" ${ev.id === current ? "selected" : ""}>${esc(eventOptionLabel(ev))}</option>`).join("");
    return `<label class="field"><span>考试批次</span><select id="${id}">${opts}</select></label>`;
  }
  function compactLabel(ev) { return ev.label.replace(/\s+/g, ""); }

  async function refreshState() {
    APP = await api("GET", "/state");
    $("#brand-title").textContent = APP.title;
    $("#brand-en").textContent = APP.stage_en;
    $("#mode-badge").hidden = !APP.demo;
    document.title = APP.title + (APP.demo ? " · 演示模式" : "");
    if (RO) $("#published-at").textContent = APP.published_at.slice(0, 16);
  }

  // ---------- 路由 ----------
  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, "");
    const [path, qs] = raw.split("?");
    const parts = path.split("/").filter(Boolean);
    const q = new URLSearchParams(qs || "");
    return { page: parts[0] || "home", id: parts[1] ? Number(parts[1]) : null, sub: parts[2] || null, q };
  }
  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  async function route() {
    const r = parseHash();
    $all("#tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === r.page));
    try {
      if (r.page === "home") {
        // 首页只放入口方块，不依赖成绩：服务或快照暂时读不到时也能显示
        try { await refreshState(); } catch (e) { /* 标题保持默认 */ }
        return renderHome();
      }
      if (r.page === "materials") {
        // 资料页不依赖成绩：朋友那边还没发布成绩时也能看资料
        try { await refreshState(); } catch (e) { if (!RO) throw e; }
        return await renderMaterials(r.q);
      }
      await refreshState();
      if (RO && !["summary", "poster", "board", "report"].includes(r.page)) return go("#/home");
      if (r.page === "report") return await renderReport(r.id, r.sub);
      if (RO && !APP.events.length) return await emptyState();
      if (r.page === "entry") return await renderEntry(r.id);
      if (r.page === "summary") return await renderSummary(r.id, r.q);
      if (r.page === "poster") return await renderPoster(r.id, r.q);
      if (r.page === "board") return await renderBoard(r.q);
      if (r.page === "settings") return await renderSettings();
      if (r.page === "publish") return await renderPublish();
      go("#/home");
    } catch (e) {
      view.innerHTML = `<div class="note err">${esc(e.message)}</div>`;
    }
  }

  // ---------- 首页：大方块入口 ----------
  const ICON = {
    entry: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
    summary: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M10 4v16"/>',
    poster: '<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="9.5" cy="9" r="2"/><path d="M4 17l5-4 4 3 3-2 4 3"/>',
    board: '<path d="M8 4h8v5a4 4 0 0 1-8 0V4z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4"/><path d="M12 13v4M8 20h8"/>',
    report: '<path d="M5 4h11l3 3v13H5z"/><path d="M9 10h6M9 14h6M9 18h3"/>',
    materials: '<path d="M4 5a2 2 0 0 1 2-2h5v17H6a2 2 0 0 0-2 2V5z"/><path d="M20 5a2 2 0 0 0-2-2h-5v17h5a2 2 0 0 1 2 2V5z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
    publish: '<path d="M12 15V4M7 9l5-5 5 5"/><path d="M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5"/>',
    teaser: '<path d="M4 10v4l11 5V5L4 10z"/><path d="M15 9a3 3 0 0 1 0 6M7 14l1 6h3l-1-5"/>',
  };
  const HOME_TILES = RO
    ? [
        { key: "board", name: "积分榜", desc: "A 分差榜 · C 联赛榜" },
        { key: "summary", name: "积分明细", desc: "每次考试每科加了多少" },
        { key: "poster", name: "学科比分", desc: "四科比分海报" },
        { key: "report", name: "战报", desc: "一科出分就公布" },
        { key: "materials", name: "学习资料", desc: "下载资料" },
      ]
    : [
        { key: "entry", name: "成绩录入", desc: "新建考试 · 填成绩 · 结算" },
        { key: "summary", name: "积分汇总", desc: "本次 / 累计积分" },
        { key: "poster", name: "学科比分海报", desc: "四科或单科海报" },
        { key: "board", name: "用户积分榜", desc: "A / C 两张榜" },
        { key: "report", name: "战报", desc: "单科 / 整场战报" },
        { key: "materials", name: "学习资料", desc: "添加与发布资料" },
        { key: "publish", name: "发布给朋友", desc: "更新朋友的看板" },
        { key: "settings", name: "设置与备份", desc: "昵称 · 头像 · 备份" },
        { key: "teaser", name: "预热海报", desc: "开战预告 · 规则速览", href: "teaser.html" },
      ];

  function renderHome() {
    const tiles = HOME_TILES.map((t) => `
      <a class="home-tile" href="${t.href || "#/" + t.key}">
        <span class="home-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${ICON[t.key]}</svg></span>
        <span class="home-name">${esc(t.name)}</span>
        <span class="home-desc">${esc(t.desc)}</span>
      </a>`).join("");
    view.innerHTML = `
      <div class="home">
        <h1 class="home-title">要去哪里？</h1>
        <div class="home-grid">${tiles}</div>
      </div>`;
  }

  async function emptyState(title) {
    if (RO) {
      const rp = await api("GET", "/reports").catch(() => ({ items: [] }));
      view.innerHTML = rp.items.length
        ? `<div class="card empty"><h2>累计榜还没有发布</h2><p class="muted">已经有 ${rp.items.length} 场考试的战报可以看。</p><div class="btns"><a class="btn primary" href="#/report">看战报 →</a></div></div>`
        : `<div class="card empty"><h2>还没有发布成绩</h2><p class="muted">等结算后发布了再来看吧。</p></div>`;
      return;
    }
    view.innerHTML = `
      <div class="card empty">
        <h2>${esc(title || "还没有考试批次")}</h2>
        <p class="muted">先新建一次周测或特殊考试，再录入两位用户的四科成绩。</p>
        <div class="btns">
          <button class="btn primary" data-act="new-weekly">新建周测</button>
          <button class="btn" data-act="new-special">新建特殊考试</button>
        </div>
      </div>`;
    bindCreateButtons(view);
  }

  function bindCreateButtons(root) {
    $all('[data-act="new-weekly"]', root).forEach((b) => b.addEventListener("click", () => openCreate("weekly")));
    $all('[data-act="new-special"]', root).forEach((b) => b.addEventListener("click", () => openCreate("special")));
  }

  // ---------- 成绩录入 ----------
  async function renderEntry(id) {
    if (!APP.events.length) return emptyState();
    if (!id || !findEvent(id)) return go(`#/entry/${defaultEventId()}`);
    pref("event", id);
    const d = await api("GET", `/events/${id}`);
    const ev = d.event;
    const special = ev.kind === "special";
    const head = `
      <section class="page-head">
        <div>
          <h1>${special ? "特殊考试录入" : "录入本周成绩"}</h1>
          <p>两位对手，四门学科。输入后自动保存草稿，结算后才进入正式累计。</p>
        </div>
        <div class="toolbar">
          ${eventSelect("ev-select", ev.id)}
          <button class="btn" data-act="new-weekly">新建周测</button>
          <button class="btn" data-act="new-special">新建特殊考试</button>
        </div>
      </section>`;
    const banner = special ? `
      <div class="special-banner">
        <div><div class="name">${esc(ev.name)}</div><div class="date">${esc(ev.exam_date)} · 独立考试批次，不覆盖任何周测</div></div>
        <div class="mult">积分 ×${esc(ev.multiplier)}</div>
      </div>` : "";
    const ths = d.subjects.map((s) => `<th><b>${esc(s.name)}</b>${s.scaled ? "已赋分 / " + esc(s.full_mark) : "满分 " + esc(s.full_mark)}</th>`).join("");
    const rows = people().map((p, idx) => {
      const tds = d.subjects.map((s) => {
        return `<td><div class="score-cell" data-subject="${s.code}" data-pid="${p.id}">
          <input class="score-input" type="text" inputmode="decimal" autocomplete="off" aria-label="${esc(p.nickname)} ${esc(s.name)}">
          <label class="absent-toggle"><input type="checkbox" class="absent-box"> 缺考</label>
          <div class="cell-status"></div>
        </div></td>`;
      }).join("");
      return `<tr><td><div class="user-cell">${avatarHtml(p, idx)}<span>${esc(p.nickname)}</span></div></td>${tds}</tr>`;
    }).join("");
    const trialTds = d.subjects.map((s) => `<td class="trial" data-trial="${s.code}"></td>`).join("");

    view.innerHTML = head + `
      <div class="card" id="entry-card">
        <div class="card-head">
          <h2>${esc(ev.name)}</h2>
          <span class="chip" id="ev-status"></span>
          <button class="btn ghost" id="edit-event">编辑批次</button>
        </div>
        ${banner}
        <div id="dirty-note"></div>
        <div class="table-wrap">
          <table class="grid entry-table">
            <thead><tr><th>参赛用户</th>${ths}</tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr><td>本科试算</td>${trialTds}</tr></tfoot>
          </table>
        </div>
        <div class="card-foot">
          <div class="grow"><span id="processed"></span> · <span id="save-state">草稿已保存</span></div>
          <div class="totals-line" id="draft-totals"></div>
          <button class="btn" id="to-summary">查看积分 →</button>
          <button class="btn" id="to-report" hidden>战报 →</button>
          <button class="btn primary" id="settle-btn">结算本次考试</button>
        </div>
      </div>
      <div class="note">C 联赛积分：胜 3、平 1、负 0；分差达满分 5% 加 1，达 10% 加 2（互斥）。A 分差积分：胜者得原始分差。缺考者两套都为 0，参考者 C 得 3（无奖励）、A 为 0。最后再乘考试倍率。两套积分各自累计，永不相加。</div>`;

    bindCreateButtons(view);
    $("#ev-select").addEventListener("change", (e) => go(`#/entry/${e.target.value}`));
    $("#edit-event").addEventListener("click", () => openEditEvent(ev));
    $("#to-summary").addEventListener("click", () => go(`#/summary/${ev.id}`));
    $("#to-report").addEventListener("click", () => go(`#/report/${ev.id}`));
    $("#settle-btn").addEventListener("click", () => settle(ev.id));

    // 填入当前值
    $all(".score-cell").forEach((cell) => {
      const sc = d.scores[cell.dataset.subject][cell.dataset.pid];
      const input = $(".score-input", cell);
      const box = $(".absent-box", cell);
      input.value = sc.status === "present" ? sc.value : "";
      box.checked = sc.status === "absent";
      input.disabled = box.checked;
      wireCell(cell, ev.id);
    });
    applyDetail(d);
  }

  let currentDetail = null;
  function applyDetail(d) {
    currentDetail = d;
    const ev = d.event;
    const [cls, txt] = STATUS_CHIP[ev.status];
    const chip = $("#ev-status");
    if (!chip) return;
    chip.className = "chip " + cls;
    chip.textContent = txt + (ev.status !== "draft" ? ` · 修订 ${ev.settled_revision}` : "");
    $("#to-report").hidden = ev.status === "draft" && !Object.values(d.draft).some(Boolean);
    $("#dirty-note").innerHTML = ev.status === "dirty"
      ? `<div class="note warn">成绩在结算后又有修改。正式榜和海报仍使用上次结算（修订 ${ev.settled_revision}）的结果，点击“重新结算”后才会替换。</div>`
      : "";
    $all(".score-cell").forEach((cell) => {
      if (cell.dataset.error) return;
      const sc = d.scores[cell.dataset.subject][cell.dataset.pid];
      const st = $(".cell-status", cell);
      st.className = "cell-status " + sc.status;
      st.textContent = sc.status === "present" ? "已录入" : sc.status === "absent" ? "缺考（不是 0 分）" : "待录入";
    });
    d.subjects.forEach((s) => {
      const td = $(`[data-trial="${s.code}"]`);
      const r = d.draft[s.code];
      td.innerHTML = r
        ? `A <b>${esc(r.a[0])} : ${esc(r.a[1])}</b><br>C <b>${esc(r.c[0])} : ${esc(r.c[1])}</b><br><a class="small" href="#/report/${ev.id}/${s.code}">发布这一科 →</a>`
        : "待录入，暂无结果";
    });
    $("#processed").textContent = `已处理 ${d.processed} / ${d.total_cells} 项`;
    const t = d.draft_totals;
    $("#draft-totals").innerHTML = t
      ? `本次试算 A <b>${esc(t.a[0])} : ${esc(t.a[1])}</b> · C <b>${esc(t.c[0])} : ${esc(t.c[1])}</b>`
      : "";
    const btn = $("#settle-btn");
    btn.disabled = !d.can_settle;
    btn.textContent = ev.status === "dirty" ? "重新结算" : ev.status === "settled" ? "已结算" : "结算本次考试";
    btn.title = d.processed < d.total_cells ? "四科八项全部处理完才能结算" : "";
  }

  function wireCell(cell, eventId) {
    const input = $(".score-input", cell);
    const box = $(".absent-box", cell);
    const st = $(".cell-status", cell);
    let timer = null;
    let lastSent = null;

    function payload() {
      if (box.checked) return { status: "absent", value: null };
      const v = input.value.trim();
      if (v === "") return { status: "pending", value: null };
      return { status: "present", value: v };
    }
    function save() {
      clearTimeout(timer);
      const body = Object.assign({ subject: cell.dataset.subject, participant_id: Number(cell.dataset.pid) }, payload());
      const key = JSON.stringify(body);
      if (key === lastSent) return;
      lastSent = key;
      $("#save-state").textContent = "正在保存…";
      st.className = "cell-status saving";
      st.textContent = "保存中…";
      saveChain = saveChain.then(async () => {
        try {
          const d = await api("PUT", `/events/${eventId}/score`, body);
          delete cell.dataset.error;
          input.classList.remove("bad");
          applyDetail(d);
          $("#save-state").textContent = "草稿已保存 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
        } catch (e) {
          lastSent = null;
          if (e.network) {
            $("#save-state").textContent = "保存失败：" + e.message;
          } else {
            $("#save-state").textContent = "有未保存的格子";
          }
          cell.dataset.error = "1";
          input.classList.add("bad");
          st.className = "cell-status error";
          st.textContent = "未保存：" + e.message;
        }
      });
    }
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(save, 700);
    });
    input.addEventListener("blur", save);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save();
        const all = $all(".score-input:not(:disabled)");
        const i = all.indexOf(input);
        if (all[i + 1]) all[i + 1].focus();
      }
    });
    box.addEventListener("change", () => {
      input.disabled = box.checked;
      if (box.checked) {
        input.value = "";
      }
      save();
    });
  }

  let settling = false;
  async function settle(eventId) {
    if (settling) return;
    settling = true;
    const btn = $("#settle-btn");
    btn.disabled = true;
    btn.textContent = "结算中…";
    try {
      await saveChain;
      const rev = currentDetail ? currentDetail.event.revision : undefined;
      const res = await api("POST", `/events/${eventId}/settle`, { revision: rev });
      toast(res.result.changed ? "已结算，A/C 两套累计榜已更新。可以点“战报”发布整场战报。" : "这次考试已经是最新结算，没有重复累计。");
      settling = false;
      await route();
    } catch (e) {
      toast(e.message, true);
      if (currentDetail) applyDetail(currentDetail);
    } finally {
      settling = false;
    }
  }

  // ---------- 新建 / 编辑批次 ----------
  function modal(html, onMount) {
    const root = $("#modal-root");
    root.innerHTML = `<div class="modal-mask"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
    const mask = $(".modal-mask", root);
    const close = () => { root.innerHTML = ""; document.removeEventListener("keydown", onKey); };
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    mask.addEventListener("mousedown", (e) => { if (e.target === mask) close(); });
    $all("[data-close]", root).forEach((b) => b.addEventListener("click", close));
    onMount($(".modal", root), close);
  }

  function multiplierPicker(value) {
    return `<div class="field"><span>积分倍率</span><div class="radio-row" id="mult-row">
      <label class="${value === "1" ? "on" : ""}"><input type="radio" name="mult" value="1" ${value === "1" ? "checked" : ""}> ×1 普通</label>
      <label class="${value === "2" ? "on" : ""}"><input type="radio" name="mult" value="2" ${value === "2" ? "checked" : ""}> ×2 双倍</label>
    </div></div>`;
  }
  function wireMultiplier(root, onTouch) {
    $all('input[name="mult"]', root).forEach((r) => r.addEventListener("change", () => {
      $all("#mult-row label", root).forEach((l) => l.classList.toggle("on", $("input", l).checked));
      if (onTouch) onTouch();
    }));
  }
  function setMultiplier(root, v) {
    $all('input[name="mult"]', root).forEach((r) => { r.checked = r.value === v; });
    $all("#mult-row label", root).forEach((l) => l.classList.toggle("on", $("input", l).checked));
  }

  function openCreate(kind) {
    const weeks = APP.events.filter((e) => e.kind === "weekly").map((e) => e.week_no);
    const nextWeek = weeks.length ? Math.max(...weeks) + 1 : 1;
    const today = APP.today;
    const body = kind === "weekly" ? `
      <h3>新建周测</h3>
      <div class="form">
        <div class="row">
          <label class="field"><span>周次</span><input type="number" min="1" max="99" id="f-week" value="${nextWeek}"></label>
          <label class="field"><span>考试日期</span><input type="date" id="f-date" value="${today}"></label>
        </div>
        <p class="muted small">周测固定 ×1。数学、英语满分 150；物理、化学为已赋分成绩，满分 70。</p>
      </div>` : `
      <h3>新建特殊考试</h3>
      <div class="form">
        <label class="field"><span>考试名称</span><input type="text" id="f-name" value="期中考试" maxlength="20"></label>
        <label class="field"><span>考试日期</span><input type="date" id="f-date" value="${today}"></label>
        ${multiplierPicker("2")}
        <p class="muted small">期中默认 ×2；其他特殊考试默认 ×1，请按需选择。特殊考试是独立批次，与周测共用累计榜，不覆盖任何周测。</p>
      </div>`;
    modal(body + `<div class="form-error" id="f-err"></div>
      <div class="actions"><button class="btn" data-close>取消</button><button class="btn primary" id="f-ok">创建</button></div>`, (root, close) => {
      let touched = false;
      if (kind === "special") {
        wireMultiplier(root, () => { touched = true; });
        $("#f-name", root).addEventListener("input", (e) => {
          if (!touched) setMultiplier(root, /期中/.test(e.target.value) ? "2" : "1");
        });
      }
      const first = $("input", root);
      first.focus();
      first.select && first.select();
      $("#f-ok", root).addEventListener("click", async () => {
        const payload = { kind, exam_date: $("#f-date", root).value };
        if (kind === "weekly") payload.week_no = $("#f-week", root).value;
        else {
          payload.name = $("#f-name", root).value;
          payload.multiplier = $('input[name="mult"]:checked', root).value;
        }
        try {
          const d = await api("POST", "/events", payload);
          close();
          toast(`已创建：${d.event.name}`);
          go(`#/entry/${d.event.id}`);
        } catch (e) {
          $("#f-err", root).textContent = e.message;
        }
      });
    });
  }

  function openEditEvent(ev) {
    const special = ev.kind === "special";
    modal(`
      <h3>编辑批次</h3>
      <div class="form">
        ${special
          ? `<label class="field"><span>考试名称</span><input type="text" id="f-name" value="${esc(ev.name)}" maxlength="20"></label>`
          : `<label class="field"><span>周次</span><input type="number" id="f-week" min="1" max="99" value="${ev.week_no}"></label>`}
        <div class="row">
          <label class="field"><span>考试日期</span><input type="date" id="f-date" value="${esc(ev.exam_date)}"></label>
          <label class="field"><span>同日排序序号</span><input type="number" id="f-seq" value="${ev.seq}"></label>
        </div>
        ${special ? multiplierPicker(ev.multiplier) : ""}
        <p class="muted small">历史榜按“日期 → 排序序号”决定先后。修改倍率会让这次考试需要重新结算；修改名称、日期不改变积分。</p>
      </div>
      <div class="form-error" id="f-err"></div>
      <div class="actions">
        <button class="btn danger left" id="f-del">删除批次</button>
        <button class="btn" data-close>取消</button>
        <button class="btn primary" id="f-ok">保存</button>
      </div>`, (root, close) => {
      if (special) wireMultiplier(root);
      $("#f-ok", root).addEventListener("click", async () => {
        const payload = { exam_date: $("#f-date", root).value, seq: $("#f-seq", root).value };
        if (special) {
          payload.name = $("#f-name", root).value;
          payload.multiplier = $('input[name="mult"]:checked', root).value;
        } else payload.week_no = $("#f-week", root).value;
        try {
          await api("PATCH", `/events/${ev.id}`, payload);
          close();
          toast("批次信息已保存");
          route();
        } catch (e) {
          $("#f-err", root).textContent = e.message;
        }
      });
      $("#f-del", root).addEventListener("click", async () => {
        const extra = ev.status !== "draft" ? "它的结算积分也会从两套累计榜中移除。" : "";
        if (!confirm(`确定删除“${ev.name}”？${extra}删除前会自动保存一份备份。`)) return;
        try {
          await api("DELETE", `/events/${ev.id}`);
          close();
          pref("event", "");
          toast("已删除，并在 backups 目录保存了删除前的备份。");
          go("#/entry");
        } catch (e) {
          $("#f-err", root).textContent = e.message;
        }
      });
    });
  }

  // ---------- 积分汇总 ----------
  function sysToggle(current) {
    return `<div class="field"><span>积分体系</span><div class="seg" id="sys-seg">
      <button data-sys="A" class="${current === "A" ? "on" : ""}">A 分差积分</button>
      <button data-sys="C" class="${current === "C" ? "on" : ""}">C 联赛积分</button>
    </div></div>`;
  }

  function calcRows(subject, scores, res, pids) {
    const cell = (pid) => {
      const s = scores[subject.code][pid];
      return s.status === "present" ? s.value : s.status === "absent" ? "缺考" : "待录入";
    };
    if (!res) return `<tr><td colspan="2" class="muted">有人待录入，暂无结果</td></tr>`;
    const caseText = { normal: "两人正常参考", absent_one: "一人缺考：参考者 C 基础 3 分、无奖励；双方 A 为 0", absent_both: "两人都缺考：双方 0 分" }[res.case];
    const bonusText = res.case !== "normal" ? "不适用"
      : res.winner == null ? "平局，无奖励"
        : res.bonus === 2 ? "+2（分差 ≥ 满分 10%）" : res.bonus === 1 ? "+1（分差 ≥ 满分 5%）" : "0（分差 < 满分 5%）";
    return `
      <tr><th>考试成绩</th><td>${esc(nick(pids[0]))} ${esc(cell(pids[0]))} : ${esc(cell(pids[1]))} ${esc(nick(pids[1]))}</td></tr>
      <tr><th>满分</th><td>${esc(res.full_mark)}${subject.scaled ? "（已赋分）" : ""}</td></tr>
      <tr><th>情况</th><td>${esc(caseText)}</td></tr>
      <tr><th>分差</th><td>${res.gap == null ? "—" : esc(res.gap) + "（占满分 " + esc(res.ratio_pct) + "%）"}</td></tr>
      <tr><th>C 优势奖励</th><td>${esc(bonusText)}</td></tr>
      <tr><th>基础积分</th><td>A ${esc(res.base_a[0])} : ${esc(res.base_a[1])} · C ${esc(res.base_c[0])} : ${esc(res.base_c[1])}</td></tr>
      <tr><th>倍率</th><td>×${esc(res.multiplier)}</td></tr>
      <tr><th>最终积分</th><td><b>A ${esc(res.a[0])} : ${esc(res.a[1])} · C ${esc(res.c[0])} : ${esc(res.c[1])}</b></td></tr>`;
  }

  async function renderSummary(id, q) {
    if (!APP.events.length) return emptyState();
    if (!id || !findEvent(id)) return go(`#/summary/${defaultEventId()}`);
    pref("event", id);
    const sys = (q.get("sys") || pref("sys") || "C").toUpperCase() === "A" ? "A" : "C";
    pref("sys", sys);
    const scope = q.get("scope") === "upto" ? "upto" : "all";
    const [d, t] = await Promise.all([
      api("GET", `/events/${id}`),
      api("GET", `/totals?event=${id}&cutoff=${scope === "upto" ? id : "all"}`),
    ]);
    const ev = d.event;
    const key = sys.toLowerCase();
    const pids = d.participants.map(String);
    const thisSettled = t.this_settled;
    const scopeText = scope === "upto" ? `截至${ev.label}` : "全部已结算考试";

    const ths = SUBJECTS.map((s) => `<th>${s.name}</th>`).join("") + "<th>总计</th>";
    const body = t[key].map((row, idx) => {
      const p = people().find((x) => x.id === row.participant_id);
      const cells = SUBJECTS.map((s) => {
        const c = row.subjects[s.code];
        return `<td><div class="pts"><span class="this ${thisSettled ? "" : "none"}">${thisSettled ? esc(signed(c.this)) : "未结算"}</span><span class="cum">/ ${esc(c.cum)}</span></div></td>`;
      }).join("");
      return `<tr><td><div class="user-cell">${avatarHtml(p, idx)}<span>${esc(p.nickname)}</span><span class="muted small">第 ${row.rank} 名</span></div></td>${cells}
        <td><div class="pts total"><span class="this ${thisSettled ? "" : "none"}">${thisSettled ? esc(signed(row.this_total)) : "未结算"}</span><span class="cum">/ ${esc(row.cum_total)}</span></div></td></tr>`;
    }).join("");

    let draftCard = "";
    if (ev.status !== "settled") {
      const dt = d.draft_totals;
      const subj = SUBJECTS.map((s) => {
        const r = d.draft[s.code];
        return `<td>${r ? esc(r[key][0]) + " : " + esc(r[key][1]) : "待录入"}</td>`;
      }).join("");
      draftCard = `
        <div class="card">
          <div class="card-head"><h3>草稿试算 · ${SYS_NAME[sys]}</h3><span class="chip draft">未结算，不计入累计</span></div>
          <div class="table-wrap"><table class="grid">
            <thead><tr><th>${esc(nick(pids[0]))} : ${esc(nick(pids[1]))}</th>${SUBJECTS.map((s) => `<th>${s.name}</th>`).join("")}<th>本次总计</th></tr></thead>
            <tbody><tr><td>试算积分</td>${subj}<td>${dt ? `<b>${esc(dt[key][0])} : ${esc(dt[key][1])}</b>` : "四科未齐"}</td></tr></tbody>
          </table></div>
          <div class="card-foot"><div class="grow">${ev.status === "dirty" ? `上表“本次”仍是修订 ${ev.settled_revision} 的结算结果。` : "这次考试还没有结算。"}</div>
          <button class="btn primary" id="goto-entry">去录入页结算 →</button></div>
        </div>`;
    }

    const calcSource = d.settlement && ev.status !== "draft"
      ? { scores: d.settlement.scores, results: d.settlement.results, label: RO ? "已结算版本" : `已结算版本（修订 ${d.settlement.revision}）` }
      : { scores: d.scores, results: d.draft, label: "当前草稿（未结算）" };
    const details = SUBJECTS.map((s) => {
      const subj = d.subjects.find((x) => x.code === s.code);
      return `<details class="calc"><summary>${s.name} 计算依据</summary><table class="calc-table">${calcRows(subj, calcSource.scores, calcSource.results[s.code], pids)}</table></details>`;
    }).join("");

    view.innerHTML = `
      <section class="page-head">
        <div><h1>每一分，都有来处</h1><p>两套积分各自累计、各自排名；切换只改变口径，不改变考试成绩。</p></div>
        <div class="toolbar">
          ${eventSelect("ev-select", ev.id)}
          ${sysToggle(sys)}
          <label class="field"><span>累计范围</span><select id="scope-select">
            <option value="all" ${scope === "all" ? "selected" : ""}>全部已结算考试</option>
            <option value="upto" ${scope === "upto" ? "selected" : ""}>截至本批次（历史榜）</option>
          </select></label>
        </div>
      </section>
      <div class="card">
        <div class="card-head">
          <h2>${SYS_NAME[sys]} · 本次 / 累计</h2>
          ${ev.multiplier !== "1" ? `<span class="chip lime">×${esc(ev.multiplier)} 已计入本次积分</span>` : ""}
          <span class="chip">累计包含本次已结算积分</span>
          <span class="chip ${STATUS_CHIP[ev.status][0]}">${STATUS_CHIP[ev.status][1]}</span>
        </div>
        <div class="table-wrap"><table class="grid">
          <thead><tr><th>参赛用户</th>${ths}</tr></thead>
          <tbody>${body}</tbody>
        </table></div>
        <div class="card-foot">
          <div class="grow">本次 = ${esc(ev.label)}；累计范围 = ${esc(scopeText)}（${t.scope.settled_count} 次已结算考试）。</div>
          <button class="btn" id="to-poster">生成比分海报</button>
          <button class="btn primary" id="to-board">查看${sys === "A" ? " A 分差榜" : " C 联赛榜"} →</button>
        </div>
      </div>
      ${draftCard}
      <div class="card">
        <div class="card-head"><h3>单科计算依据</h3><span class="chip">${esc(calcSource.label)}</span></div>
        ${details}
      </div>`;

    $("#ev-select").addEventListener("change", (e) => go(`#/summary/${e.target.value}?sys=${sys}&scope=${scope}`));
    $("#scope-select").addEventListener("change", (e) => go(`#/summary/${id}?sys=${sys}&scope=${e.target.value}`));
    $all("#sys-seg button").forEach((b) => b.addEventListener("click", () => go(`#/summary/${id}?sys=${b.dataset.sys}&scope=${scope}`)));
    $("#to-poster").addEventListener("click", () => go(`#/poster/${id}`));
    $("#to-board").addEventListener("click", () => go(`#/board?sys=${sys}&cutoff=${scope === "upto" ? id : "all"}`));
    const ge = $("#goto-entry");
    if (ge) ge.addEventListener("click", () => go(`#/entry/${id}`));
  }

  // ---------- 海报公用 ----------
  function fmtDate(iso) { return String(iso).replace(/-/g, "."); }

  function exportPanel(note) {
    if (RO) {
      return `<div class="card">
      <div class="card-head"><h3>保存图片</h3></div>
      <div class="stack">
        ${note || ""}
        <button class="btn primary" id="download-btn">下载 JPG</button>
        <div class="muted small">手机上也可以长按图片保存。</div>
      </div></div>`;
    }
    return `<div class="card">
      <div class="card-head"><h3>导出 JPG</h3></div>
      <div class="stack">
        ${note || ""}
        <button class="btn primary" id="export-btn">导出 JPG 到 exports 文件夹</button>
        <button class="btn" id="download-btn">另存到浏览器下载</button>
        <button class="btn ghost" id="open-exports">打开导出文件夹</button>
        <div id="export-result" class="muted small"></div>
        <div class="muted small">宽 1080 像素，JPG 质量 0.95，不含页面按钮和导航。</div>
      </div></div>`;
  }

  function wireExport(canvas, filename) {
    if (RO) {
      // 手机上长按 <img> 才能保存，所以只读看板把画布换成同内容的图片
      const img = document.createElement("img");
      img.className = "poster-img";
      img.alt = filename;
      img.src = window.Poster.toJpeg(canvas);
      canvas.replaceWith(img);
      $("#download-btn").addEventListener("click", () => {
        const a = document.createElement("a");
        a.href = img.src;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      });
      return;
    }
    $("#export-btn").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const data = window.Poster.toJpeg(canvas);
        const res = await api("POST", "/exports", { filename, data });
        $("#export-result").innerHTML = `已保存：<div class="path">${esc(res.path)}</div>`;
        toast("JPG 已导出");
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
      }
    });
    $("#download-btn").addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = window.Poster.toJpeg(canvas);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
    $("#open-exports").addEventListener("click", () => api("POST", "/open-folder", { which: "exports" }).catch((e) => toast(e.message, true)));
  }

  // ---------- 学科比分海报 ----------
  async function renderPoster(id, q) {
    if (!APP.events.length) return emptyState();
    if (!id || !findEvent(id)) return go(`#/poster/${defaultEventId()}`);
    pref("event", id);
    const subject = SUBJECTS.some((s) => s.code === q.get("subject")) ? q.get("subject") : "all";
    const d = await api("GET", `/events/${id}`);
    const ev = d.event;
    const useSettled = d.settlement && ev.status !== "draft";
    const scores = useSettled ? d.settlement.scores : d.scores;
    const pids = d.participants.map(String);
    const chosen = subject === "all" ? d.subjects : d.subjects.filter((s) => s.code === subject);
    const rows = chosen.map((s) => {
      const cells = pids.map((pid) => scores[s.code][pid]);
      const sts = cells.map((c) => c.status);
      const state = sts.includes("pending") ? "待录入" : sts.includes("absent") ? "有缺考" : "成绩已齐";
      const caption = sts.includes("pending") ? "待录入 · 暂无正式结果" : sts.includes("absent") ? "缺考不计分差" : "考试原始分数";
      return {
        subject: s.name,
        meta: (s.scaled ? `已赋分 / 满分 ${s.full_mark}` : `满分 ${s.full_mark}`) + " · " + state,
        cells,
        caption,
      };
    });
    const special = ev.kind === "special";
    const single = subject !== "all";
    const subjName = single ? chosen[0].name : "";
    let title, tag;
    if (single) {
      title = `${ev.label} · ${subjName}对决`;
      tag = special ? ev.name : `常规周测 · ${subjName}`;
    } else if (special) {
      title = /期中/.test(ev.name) ? "期中学科对决" : `${ev.name}学科对决`;
      tag = ev.name;
    } else {
      title = "本周学科对决";
      tag = `${ev.label} · 四科周测`;
    }
    const sourceText = useSettled
      ? (ev.status === "dirty" ? `上次结算版本（修订 ${d.settlement.revision}），之后的修改尚未结算` : RO ? "已结算" : `已结算 · 修订 ${d.settlement.revision}`)
      : "未结算草稿，仅供预览";
    const posterData = {
      kicker: "ACADEMIC LEAGUE / " + APP.stage_en,
      title,
      tag,
      multiplierBadge: ev.multiplier !== "1" ? `积分 ×${ev.multiplier}` : "",
      metaLine: `${fmtDate(ev.exam_date)} · ${single ? "单科成绩" : "四科成绩"} · 原始分数${ev.multiplier !== "1" ? "（倍率只作用于积分）" : ""}`,
      rows,
      participants: people(),
      projectTitle: APP.title,
      slogan: "每一科，都是一次交锋。",
      footnote: sourceText + (APP.demo ? " · 演示数据" : ""),
    };
    const filename = `${APP.title}_${compactLabel(ev)}_${single ? subjName + "比分" : "学科比分"}.jpg`;

    const subjOpts = [`<option value="all">四科合图</option>`].concat(d.subjects.map((s) => `<option value="${s.code}" ${s.code === subject ? "selected" : ""}>${s.name}（单科）</option>`)).join("");
    view.innerHTML = `
      <section class="page-head">
        <div><h1>学科比分海报</h1><p>中央永远是考试原始分数（物理化学为已赋分成绩），不是积分。</p></div>
        <div class="toolbar">
          ${eventSelect("ev-select", ev.id)}
          <label class="field"><span>海报内容</span><select id="subj-select">${subjOpts}</select></label>
        </div>
      </section>
      <div class="poster-layout">
        <div class="poster-frame"><canvas id="poster"></canvas></div>
        <div class="side-panel">
          ${exportPanel(`<div class="note ${useSettled && ev.status === "settled" ? "" : "warn"}">数据来源：${esc(sourceText)}</div>`)}
          <div class="card"><div class="muted small">文件名：</div><div class="path">${esc(filename)}</div></div>
        </div>
      </div>`;
    $("#ev-select").addEventListener("change", (e) => go(`#/poster/${e.target.value}?subject=${subject}`));
    $("#subj-select").addEventListener("change", (e) => go(`#/poster/${id}?subject=${e.target.value}`));
    const canvas = $("#poster");
    await window.Poster.drawScorePoster(canvas, posterData);
    wireExport(canvas, filename);
  }

  // ---------- 用户积分榜 ----------
  async function renderBoard(q) {
    const sys = (q.get("sys") || pref("sys") || "C").toUpperCase() === "A" ? "A" : "C";
    pref("sys", sys);
    let cutoff = q.get("cutoff") || "all";
    if (cutoff !== "all" && !findEvent(cutoff)) cutoff = "all";
    const b = await api("GET", `/board?system=${sys}&cutoff=${cutoff}`);
    const cutEv = b.scope.cutoff_event;
    const last = b.scope.last_settled;
    const scopeLabel = cutEv ? `截至${cutEv.label}` : last ? `截至${last.label}（全部已结算）` : "暂无已结算考试";
    const thisEv = b.this_event;
    const tiedRanks = {};
    b.rows.forEach((r) => { tiedRanks[r.rank] = (tiedRanks[r.rank] || 0) + 1; });
    const rows = b.rows.map((r) => ({
      participant_id: r.participant_id,
      rank: r.rank,
      tied: tiedRanks[r.rank] > 1,
      thisText: r.this_total == null ? "—" : signed(r.this_total),
      cumText: r.cum_total,
    }));
    let bigLabel = "—";
    if (thisEv) bigLabel = thisEv.kind === "weekly" ? String(thisEv.week_no).padStart(2, "0") : thisEv.name.replace(/考试$/, "");
    const posterData = {
      kicker: "ACADEMIC LEAGUE / " + APP.stage_en,
      title1: `${APP.stage} · 双人联赛`,
      title2: BOARD_NAME[sys],
      scopeLine: `${scopeLabel} · ${b.scope.settled_count} 次已结算考试`,
      sectionTitle: sys === "A" ? "每一分差，都记在账上" : "积分见证每一次超越",
      thisHeader: thisEv ? `本次（${thisEv.label.replace(/\s+/g, "")}）` : "本次",
      rows,
      participants: people(),
      bigLabel,
      footLeft: sys === "A" ? "A 分差积分 · 胜者得原始分差 · 与 C 榜独立累计" : "C 联赛积分 · 胜3 平1 负0 + 优势奖励 · 与 A 榜独立累计",
      footRight: (APP.demo ? "演示数据 · " : RO ? "发布 " : "导出 ") + fmtDate(APP.today),
    };
    const filename = `${APP.title}_${(cutEv ? "截至" + compactLabel(cutEv) : last ? "截至" + compactLabel(last) : "暂无结算")}_${sys === "A" ? "A分差榜" : "C联赛榜"}.jpg`;
    const cutOpts = [`<option value="all">全部已结算考试</option>`].concat(eventsNewestFirst().map((ev) => `<option value="${ev.id}" ${String(ev.id) === String(cutoff) ? "selected" : ""}>截至 ${esc(ev.label)}${ev.status === "draft" ? "（本批未结算）" : ""}</option>`)).join("");
    view.innerHTML = `
      <section class="page-head">
        <div><h1>用户积分榜</h1><p>A 分差榜与 C 联赛榜分别排序，同分并列，不用另一套积分破同分。</p></div>
        <div class="toolbar">
          ${sysToggle(sys)}
          <label class="field"><span>截止范围</span><select id="cut-select">${cutOpts}</select></label>
        </div>
      </section>
      ${cheerBar()}
      <div class="poster-layout">
        <div class="poster-frame"><canvas id="poster"></canvas></div>
        <div class="side-panel">
          ${exportPanel(`<div class="note">${esc(BOARD_NAME[sys])} · ${esc(scopeLabel)}。只计入已结算考试；草稿与未结算修改不会出现在榜上。</div>`)}
          <div class="card"><div class="muted small">文件名：</div><div class="path">${esc(filename)}</div></div>
        </div>
      </div>`;
    $all("#sys-seg button").forEach((btn) => btn.addEventListener("click", () => go(`#/board?sys=${btn.dataset.sys}&cutoff=${cutoff}`)));
    $("#cut-select").addEventListener("change", (e) => go(`#/board?sys=${sys}&cutoff=${e.target.value}`));
    wireCheer(view);
    const canvas = $("#poster");
    await window.Poster.drawBoardPoster(canvas, posterData);
    wireExport(canvas, filename);
  }

  // ---------- 战报（单科 / 整场） ----------
  // 某一科两人成绩出齐就能单独发布这一科；整场结算后还可以发布整场战报。
  function kindText(ev) { return ev.kind === "weekly" ? "常规周测" : `特殊考试 ×${ev.multiplier}`; }
  function reportTitle(ev) { return ev.kind === "weekly" ? `${ev.label}战报` : `${ev.name}战报`; }
  function subjName(code) { const s = SUBJECTS.find((x) => x.code === code); return s ? s.name : code; }
  function pubAt(p) { return p && p.at ? p.at.slice(5, 16) : ""; }
  function publishedParts(it) {
    return it.subjects.filter((s) => s.published).map((s) => s.name).concat(it.exam.published ? ["整场"] : []);
  }
  function reportChip(it) {
    const parts = publishedParts(it);
    if (RO) return parts.length ? `<span class="chip">${esc(parts.join(" · "))}</span>` : "";
    if (it.status === "missing") return `<span class="chip warn">本机已删除 · 朋友仍能看到</span>`;
    const stale = it.subjects.some((s) => s.stale) || it.exam.stale;
    if (!parts.length) return `<span class="chip draft">未发布</span>`;
    return `<span class="chip ${stale ? "warn" : "ok"}">已发布 ${esc(parts.join("、"))}${stale ? " · 有改动未更新" : ""}</span>`;
  }
  function itemChip(x, ready) {
    if (!ready && x.published) return `<span class="chip warn">已发布 · 本机已没有这份成绩</span>`;
    if (!ready) return `<span class="chip draft">${RO ? "待公布" : "未出齐"}</span>`;
    if (RO) return `<span class="chip ok">已公布</span>`;
    if (!x.published) return `<span class="chip draft">未发布</span>`;
    if (x.stale) return `<span class="chip warn">已发布旧版</span>`;
    return `<span class="chip ok">已发布 ${esc(pubAt(x.published))}</span>`;
  }
  // 这一场能看的项：已出分的科目 + 结算后的整场；只读看板只列已发布的
  function reportViews(it) {
    const v = it.subjects.filter((s) => (RO ? s.published : s.ready)).map((s) => s.code);
    if (RO ? it.exam.published : it.settled) v.push("exam");
    return v;
  }
  function sumPairs(list) {
    return list.reduce((acc, x) => [acc[0] + Number(x[0]), acc[1] + Number(x[1])], [0, 0]).map((n) => String(Math.round(n * 100) / 100));
  }

  function subjectPosterData(r, persons) {
    const ev = r.event;
    const s = r.subject_info;
    const res = r.result;
    const byId = (pid) => persons.find((x) => x.id === Number(pid)) || { id: Number(pid), nickname: "?", avatar: null };
    const ps = r.participants.map(byId);
    const names = ps.map((p) => p.nickname);
    const cells = r.participants.map((pid) => r.scores[String(pid)]);
    const w = res.winner == null ? null : Number(res.winner);
    const mult = ev.multiplier !== "1" ? ` ×${ev.multiplier}` : "";
    const win = (vals) => (Number(vals[0]) === Number(vals[1]) ? null : Number(vals[0]) > Number(vals[1]) ? 0 : 1);
    let verdict, aNote, cNote;
    if (res.case === "normal") {
      verdict = w == null ? "同分战平" : `${names[w]} 胜 ${res.gap} 分`;
      aNote = w == null ? "同分，双方都是 0" : `胜者得原始分差 ${res.gap}${mult}`;
      cNote = w == null ? `平局各得 1${mult}`
        : res.bonus ? `胜 3 + 优势奖励 ${res.bonus}（分差 ${res.ratio_pct}%）${mult}` : `胜 3（分差 ${res.ratio_pct}%，未达 5% 无奖励）${mult}`;
    } else if (res.case === "absent_one") {
      verdict = `${names[1 - w]} 缺考`;
      aNote = "有人缺考，A 分差积分不计";
      cNote = `参考者得 3，无奖励${mult}`;
    } else {
      verdict = "双方缺考";
      aNote = "双方缺考，不计分";
      cNote = "双方缺考，不计分";
    }
    const b = r.before;
    return {
      kicker: "ACADEMIC LEAGUE / " + APP.stage_en + " · SUBJECT REPORT",
      title: `${s.name}战报`,
      tag: `${ev.kind === "weekly" ? ev.label : ev.name} · ${s.name}`,
      multiplierBadge: ev.multiplier !== "1" ? `积分 ×${ev.multiplier}` : "",
      metaLine: `${fmtDate(ev.exam_date)} · ${s.scaled ? "已赋分 / " : ""}满分 ${s.full_mark} · 中间是原始分数${mult ? "，倍率只作用于积分" : ""}`,
      participants: ps,
      cells,
      winner: w,
      verdict,
      points: [
        { label: "A 分差积分", values: res.a, winner: win(res.a), note: aNote },
        { label: "C 联赛积分", values: res.c, winner: win(res.c), note: cNote },
      ],
      beforeTitle: r.prev_label ? `战前累计 · 截至${r.prev_label}` : "战前累计",
      beforeLine: r.prev_label ? `A ${b.a[0]} : ${b.a[1]}　·　C ${b.c[0]} : ${b.c[1]}` : "联赛首战，双方都从 0 分开始",
      projectTitle: APP.title,
      slogan: "这一科，先见分晓。",
      footnote: (r.settled ? "整场已结算" : "单科先发 · 本场还没结算，正式累计以整场结算为准")
        + (RO ? " · 发布 " + fmtDate(r.published_at.slice(0, 10)) : "") + (APP.demo ? " · 演示数据" : ""),
    };
  }

  /* 两人名次变化的一句话 */
  function standingStory(st, names) {
    const [p, q] = st;
    const after = [Number(p.after), Number(q.after)];
    const gap = Math.abs(after[0] - after[1]);
    if (after[0] === after[1]) return p.rank_before == null ? `首战战平，各 ${p.after} 分` : `双方 ${p.after} 分战平`;
    const lead = after[0] > after[1] ? 0 : 1;
    const L = names[lead];
    if (p.rank_before == null) return `${L} 首战领先 ${gap} 分`;
    const before = [Number(p.before), Number(q.before)];
    const gap0 = before[lead] - before[1 - lead];
    if (gap0 < 0) return `${L} 反超登顶，领先 ${gap} 分`;
    if (gap0 === 0) return `${L} 打破平局，领先 ${gap} 分`;
    if (gap > gap0) return `${L} 继续领跑，优势扩大到 ${gap} 分`;
    if (gap < gap0) return `${L} 仍领先，差距缩小到 ${gap} 分`;
    return `${L} 继续领跑，领先 ${gap} 分`;
  }

  function reportPosterData(r, persons) {
    const ev = r.event;
    const byId = (pid) => persons.find((x) => x.id === Number(pid)) || { id: Number(pid), nickname: "?", avatar: null };
    const ps = r.participants.map(byId);
    const names = ps.map((p) => p.nickname);
    const win = (vals) => (Number(vals[0]) === Number(vals[1]) ? null : Number(vals[0]) > Number(vals[1]) ? 0 : 1);
    const verdict = (vals) => { const w = win(vals); return w == null ? "本场打平" : `${names[w]} 胜`; };
    const thisLines = [["A 分差积分", "a"], ["C 联赛积分", "c"]].map(([label, k]) => ({
      label, values: r.totals[k], winner: win(r.totals[k]), verdict: verdict(r.totals[k]),
    }));
    const subjects = r.subjects.map((s) => {
      const res = r.results[s.code];
      const cells = r.participants.map((pid) => r.scores[s.code][String(pid)]);
      const absent = cells.some((c) => c.status === "absent");
      return {
        name: s.name,
        meta: (s.scaled ? "已赋分 · " : "") + `满分 ${s.full_mark}` + (absent ? " · 有缺考" : ""),
        cells, a: res.a, c: res.c,
        winner: res.winner == null ? null : Number(res.winner),
      };
    });
    const order = (list) => r.participants.map((pid) => list.find((x) => x.participant_id === Number(pid)));
    const standings = [["A 分差积分榜", "a"], ["C 联赛积分榜", "c"]].map(([label, k]) => {
      const st = order(r.standings[k]);
      return {
        label,
        after: st.map((x) => x.after),
        leader: win(st.map((x) => x.after)),
        delta: st.map((x) => `本场 ${signed(x.this)}　战前 ${x.before}`),
        story: standingStory(st, names),
      };
    });
    return {
      kicker: "ACADEMIC LEAGUE / " + APP.stage_en + " · BATTLE REPORT",
      title: reportTitle(ev),
      tag: ev.kind === "weekly" ? `${ev.label} · 四科周测` : ev.name,
      multiplierBadge: ev.multiplier !== "1" ? `积分 ×${ev.multiplier}` : "",
      metaLine: `${fmtDate(ev.exam_date)} · 第 ${r.nth} 次已结算考试 · 中间是原始分数${ev.multiplier !== "1" ? "，倍率只作用于积分" : ""}`,
      participants: ps,
      thisLines,
      subjects,
      standings,
      standingsNote: r.prev_label ? `累计至本场 · 战前 = 截至${r.prev_label}` : "累计至本场 · 联赛首战",
      projectTitle: APP.title,
      slogan: "每一场，都写进战史。",
      footnote: (RO ? "已结算成绩 · 发布 " + fmtDate(r.published_at.slice(0, 10)) : "已结算成绩 · 修订 " + ev.revision) + (APP.demo ? " · 演示数据" : ""),
    };
  }

  async function renderReport(id, sub) {
    const list = await api("GET", "/reports");
    const items = list.items.slice().sort((a, b) => (b.exam_date + String(b.id).padStart(6, "0")).localeCompare(a.exam_date + String(a.id).padStart(6, "0")));
    if (!id) return renderReportList(items);
    const it = items.find((x) => x.id === id);
    if (!it) {
      if (!items.length) return renderReportList(items);
      view.innerHTML = `<div class="card empty"><h2>${RO ? "这份战报不在了" : "这场考试还没有可以发布的战报"}</h2><p class="muted">${RO ? "可能已经撤下，看看其他场次吧。" : "某一科两个人的成绩都录完，就能发布这一科。"}</p><div class="btns"><a class="btn primary" href="#/report">全部战报 →</a></div></div>`;
      return;
    }
    const views = reportViews(it);
    let cur = views.includes(sub) ? sub : null;
    if (!cur && views.length) cur = views.includes("exam") ? "exam" : views[views.length - 1];
    const info = RO ? null : await api("GET", "/publish");
    const evLike = { kind: it.kind, label: it.label, name: it.name, multiplier: it.multiplier };

    const tabs = SUBJECTS.map((s) => ({ key: s.code, name: s.name })).concat([{ key: "exam", name: "整场" }])
      .filter((t) => !RO || views.includes(t.key))
      .map((t) => {
        const ok = views.includes(t.key);
        const why = t.key === "exam" ? "整场结算后才有整场战报" : "两个人的成绩还没录完";
        return `<button data-view="${t.key}" class="${t.key === cur ? "on" : ""}" ${ok ? "" : `disabled title="${why}"`}>${t.name}</button>`;
      }).join("");
    const opts = items.filter((x) => reportViews(x).length).map((x) => `<option value="${x.id}" ${x.id === id ? "selected" : ""}>${esc(x.label)} · ${esc(x.exam_date)}</option>`).join("");

    // 本场各科
    const subjRows = it.subjects.map((s) => {
      const ready = RO ? !!s.published : s.ready;
      const val = (k) => (ready && s[k] ? `${esc(s[k][0])} : ${esc(s[k][1])}` : "—");
      const orphan = !RO && s.published && !s.ready;
      return `<tr class="${s.code === cur ? "on" : ""}" ${ready ? `data-go="${s.code}"` : ""}><td><b>${esc(s.name)}</b></td><td>${val("a")}</td><td>${val("c")}</td>
        <td>${itemChip(s, ready)}${orphan ? ` <button class="btn ghost small-btn" data-withdraw="${s.code}">撤下</button>` : ""}</td></tr>`;
    }).join("");
    const done = it.subjects.filter((s) => (RO ? s.published : s.ready));
    const examReady = RO ? !!it.exam.published : it.settled;
    const examOrphan = !RO && it.exam.published && !it.settled;
    const progress = `<div class="card">
      <div class="card-head"><h3>本场各科</h3><span class="chip">${RO ? "已公布" : "已出齐"} ${done.length} / 4 科</span></div>
      <div class="table-wrap"><table class="report-progress">
        <thead><tr><th>科目</th><th>A 分差</th><th>C 联赛</th><th></th></tr></thead>
        <tbody>${subjRows}
          <tr class="${cur === "exam" ? "on" : ""}" ${examReady ? `data-go="exam"` : ""}><td><b>整场</b></td><td colspan="2">${it.totals ? `A ${esc(it.totals.a[0])} : ${esc(it.totals.a[1])} · C ${esc(it.totals.c[0])} : ${esc(it.totals.c[1])}` : `<span class="muted">${RO ? "待公布" : "结算后可发"}</span>`}</td>
          <td>${itemChip(it.exam, examReady)}${examOrphan ? ` <button class="btn ghost small-btn" data-withdraw="exam">撤下</button>` : ""}</td></tr>
        </tbody>
      </table></div>
      ${done.length && !it.totals ? (() => { const a = sumPairs(done.map((s) => s.a)); const c = sumPairs(done.map((s) => s.c)); return `<div class="muted small" style="margin-top:8px">已出 ${done.length} 科小计：A ${a[0]} : ${a[1]} · C ${c[0]} : ${c[1]}（本场还没结算，不进累计榜）</div>`; })() : ""}
    </div>`;

    const head = `
      <section class="page-head">
        <div><h1>${esc(reportTitle(evLike))}</h1><p>${esc(fmtDate(it.exam_date))} · ${esc(kindText(evLike))} · ${RO ? "单科成绩出来就先公布，整场结算后还有整场战报。" : "某一科两人成绩出齐就能单独发布这一科，不用等整场结算。"}</p></div>
        <div class="toolbar">
          <label class="field"><span>考试</span><select id="rep-select">${opts || `<option>${esc(it.label)}</option>`}</select></label>
          <div class="field"><span>战报</span><div class="seg" id="rep-seg">${tabs}</div></div>
        </div>
      </section>`;

    if (!cur) {
      view.innerHTML = head + `<div class="note warn">${it.status === "missing" ? "这场考试已经在本机删除，但朋友那边还能看到下面已发布的战报，可以撤下。" : "这场考试还没有哪一科两个人都录完。"}</div>${progress}<div id="rep-result" class="small"></div>`;
      wireReportPage(it, null, id);
      return;
    }
    const r = await api("GET", cur === "exam" ? `/report/${id}` : `/report/${id}/${cur}`);
    const target = cur === "exam" ? Object.assign({ sub: null, title: "整场战报" }, it.exam)
      : Object.assign({ sub: cur, title: `${subjName(cur)}战报` }, it.subjects.find((s) => s.code === cur));
    const filename = `${APP.title}_${compactLabel(r.event)}_${cur === "exam" ? "整场" : subjName(cur)}战报.jpg`;
    let side;
    if (RO) {
      const inMain = !!findEvent(id);
      side = `<div class="card"><div class="card-head"><h3>更多</h3></div><div class="btns">
        ${inMain ? `<a class="btn" href="#/summary/${id}">这场的积分明细</a><a class="btn" href="#/poster/${id}">学科比分海报</a>` : ""}
        <a class="btn ghost" href="#/report">全部战报</a></div></div>`;
    } else {
      side = reportPublishCard(it, target, info);
    }
    const note = cur === "exam"
      ? "整场战报只用这场考试<b>已结算</b>的成绩；战后积分 = 截至这场的累计。"
      : (r.settled ? "这一科的成绩已经随整场结算。" : "单科战报用的是这一科<b>现在录入</b>的成绩，整场还没结算，不进累计榜。");
    view.innerHTML = head + `
      <div class="poster-layout">
        <div class="poster-frame"><canvas id="poster"></canvas></div>
        <div class="side-panel">
          ${RO ? progress + side + cheerBar(true) : side + progress}
          ${exportPanel(`<div class="note">${RO ? (cur === "exam" ? "这是整场考试的战报。" : "这是单科先发的战报，整场结算后以正式成绩为准。") : note}</div>`)}
        </div>
      </div>`;
    wireReportPage(it, target, id);
    wireCheer(view);
    const canvas = $("#poster");
    if (cur === "exam") await window.Poster.drawReportPoster(canvas, reportPosterData(r, people()));
    else await window.Poster.drawSubjectPoster(canvas, subjectPosterData(r, people()));
    wireExport(canvas, filename);
  }

  function renderReportList(items) {
    const shown = items.filter((it) => reportViews(it).length || publishedParts(it).length);
    const rows = shown.map((it) => {
      const done = it.subjects.filter((s) => (RO ? s.published : s.ready)).map((s) => s.name);
      const prog = it.settled && !RO ? "四科已结算" : done.length ? `${RO ? "已公布" : "已出齐"}：${done.join("、")}` : "";
      return `
      <a class="report-row" href="#/report/${it.id}">
        <div class="grow"><b>${esc(it.label)}</b> <span class="muted small">${esc(it.exam_date)} · ${esc(kindText(it))}</span>
          <div class="muted small">${esc(prog)}${it.totals ? ` · 整场 A ${esc(it.totals.a[0])} : ${esc(it.totals.a[1])} · C ${esc(it.totals.c[0])} : ${esc(it.totals.c[1])}` : ""}</div></div>
        ${reportChip(it)}
        <span class="go">→</span>
      </a>`;
    }).join("");
    view.innerHTML = `
      <section class="page-head">
        <div><h1>战报</h1><p>${RO ? "单科成绩一出来就先公布，整场结算后还有整场战报。" : "某一科两个人的成绩出齐，就能单独发布这一科的战报；整场结算后还可以发布整场战报。和累计榜分开发布、互不影响。"}</p></div>
      </section>
      <div class="card">
        ${shown.length ? `<div class="report-list">${rows}</div>` : `<div class="empty"><h2>${RO ? "还没有发布战报" : "还没有可以发布的战报"}</h2><p class="muted">${RO ? "等下一科出分吧。" : "在“成绩录入”里把某一科两个人的成绩录完，这里就能发布这一科。"}</p></div>`}
      </div>`;
  }

  /* 控制端：当前这份战报（某一科或整场）的发布 / 更新 / 撤下 */
  function reportPublishCard(it, t, info) {
    const s = info.settings;
    const ready = s.owner && s.repo && s.has_token;
    let state;
    if (!t.published) state = `<div class="note">这份战报还没有发布。发布后朋友打开下面的链接就能看到；累计榜不会跟着变。</div>`;
    else if (t.stale) state = `<div class="note warn">朋友看到的是 ${esc(pubAt(t.published))} 发布的旧版本，之后${t.sub ? "这一科的成绩或倍率改过" : "这场又重新结算过"}。点“更新”换成现在的版本。</div>`;
    else state = `<div class="note">已发布（${esc(pubAt(t.published))}），朋友看到的就是左边这张。</div>`;
    const verb = t.published ? (t.stale ? "更新" : "重新发布") : "发布";
    return `<div class="card">
      <div class="card-head"><h3>发布${esc(t.title)}</h3>${itemChip(t, true)}</div>
      <div class="stack" style="display:flex;flex-direction:column;gap:10px">
        ${state}
        ${info.demo ? `<div class="note warn">演示模式只能预览，不能发布。</div>` : !ready ? `<div class="note warn">还没有完成 GitHub 设置，请先到 <a href="#/publish">发布给朋友</a> 填写。</div>` : ""}
        <div class="btns">
          <button class="btn" id="rep-preview">预览朋友看到的</button>
          <button class="btn primary" id="rep-publish" ${ready && !info.demo ? "" : "disabled"}>${verb}${t.sub ? "这一科" : "整场战报"}</button>
          ${t.published && ready && !info.demo ? `<button class="btn ghost" id="rep-withdraw">撤下</button>` : ""}
        </div>
        <div id="rep-result" class="small"></div>
        ${t.url ? `<div class="muted small">这份战报的链接：</div><div class="path">${esc(t.url)}</div><div class="btns"><button class="btn ghost" id="rep-copy">复制链接</button></div>` : ""}
      </div></div>`;
  }

  function wireReportPage(it, t, id) {
    const on = (sel, fn) => { const el = $(sel); if (el) el.addEventListener("click", fn); };
    const sel = $("#rep-select");
    if (sel) sel.addEventListener("change", (e) => go(`#/report/${e.target.value}`));
    $all("#rep-seg button").forEach((b) => b.addEventListener("click", () => go(`#/report/${id}/${b.dataset.view}`)));
    $all(".report-progress tr[data-go]").forEach((tr) => tr.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      go(`#/report/${id}/${tr.dataset.go}`);
    }));
    if (RO) return;
    const busy = (flag) => $all("#rep-publish, #rep-withdraw, [data-withdraw]").forEach((b) => { b.disabled = flag; });
    async function run(btn, path, sub, okText) {
      const text = btn.textContent;
      busy(true);
      btn.textContent = "正在上传…";
      try {
        const res = await api("POST", path, { event: it.id, subject: sub });
        const msg = res.result.changed ? okText : "内容和上次一样，无需更新";
        toast(msg);
        await route();
        const box = $("#rep-result");
        if (box) box.innerHTML = `<div class="note">${msg}。朋友刷新网页即可看到（GitHub 一般 1–2 分钟内更新）。${res.report_url ? `<div class="path">${esc(res.report_url)}</div>` : ""}${res.pages_enabled ? "" : "<b>还差一步：</b>到仓库 Settings → Pages，把 Source 设为 “Deploy from a branch”、分支选 main、目录 / (root)，保存。只需要做一次。"}</div>`;
      } catch (err) {
        const box = $("#rep-result");
        if (box) box.innerHTML = `<div class="note err">${esc(err.message)}</div>`;
        busy(false);
        btn.textContent = text;
      }
    }
    $all("[data-withdraw]").forEach((b) => b.addEventListener("click", (e) => {
      const sub = b.dataset.withdraw === "exam" ? null : b.dataset.withdraw;
      if (!confirm(`撤下${it.label}${sub ? subjName(sub) : "整场"}的战报？朋友那边就看不到了（累计榜不变）。`)) return;
      run(e.currentTarget, "/publish/report/withdraw", sub, "战报已撤下");
    }));
    if (!t) return;
    const what = `${it.label}${t.sub ? subjName(t.sub) : "整场"}`;
    on("#rep-preview", async () => {
      const w = window.open("about:blank", "_blank");
      try {
        const r = await api("POST", "/publish/preview", { report: it.id, subject: t.sub });
        if (w) w.location = r.url; else location.href = r.url;
      } catch (e) {
        if (w) w.close();
        toast(e.message, true);
      }
    });
    on("#rep-publish", (e) => {
      const q = t.sub
        ? `发布${what}的战报？朋友会看到这一科现在录入的成绩和积分（整场还没结算的话，不会进累计榜）。`
        : `发布${what}战报？朋友会看到这场已结算的成绩、积分和战后累计。累计榜不变。`;
      if (!confirm(q)) return;
      run(e.currentTarget, "/publish/report", t.sub, "战报已发布");
    });
    on("#rep-withdraw", (e) => {
      if (!confirm(`撤下${what}的战报？朋友那边就看不到了（累计榜不变）。`)) return;
      run(e.currentTarget, "/publish/report/withdraw", t.sub, "战报已撤下");
    });
    on("#rep-copy", async () => {
      try { await navigator.clipboard.writeText(t.url); toast("链接已复制"); } catch (e) { toast("复制失败，请手动选中复制", true); }
    });
  }

  // ---------- 加油 ----------
  // 点“加油”：头像上冒出“你要加油啊”，手机震动一下，然后跳到学习资料页。
  // 只是本机的动画，不记录、不上传任何东西。
  function cheerBar(compact) {
    if (!APP || !APP.participants || !APP.participants.length) return "";
    const ps = people().map((p, idx) => `
      <div class="cheer-person" data-pid="${p.id}">
        <div class="cheer-avatar">${avatarHtml(p, idx, compact ? "" : "lg")}</div>
        <div class="cheer-name">${esc(p.nickname)}</div>
        <button class="btn lime cheer-btn" data-pid="${p.id}" aria-label="给 ${esc(p.nickname)} 加油">💪 加油</button>
      </div>`).join("");
    return `<div class="card cheer-bar ${compact ? "compact" : ""}">
      <div class="cheer-people">${ps}</div>
      <p class="muted small cheer-tip">给谁打打气？点“加油”，然后一起去看学习资料。</p>
    </div>`;
  }
  function wireCheer(root) {
    $all(".cheer-btn", root).forEach((btn) => btn.addEventListener("click", () => {
      const box = btn.closest(".cheer-person");
      const bar = btn.closest(".cheer-bar");
      if (bar.classList.contains("busy")) return;
      bar.classList.add("busy");
      box.classList.add("cheering");
      $all(".cheer-btn", bar).forEach((b) => { b.disabled = true; });
      const bubble = document.createElement("div");
      bubble.className = "cheer-bubble";
      bubble.textContent = "你要加油啊";
      $(".cheer-avatar", box).appendChild(bubble);
      // 安卓手机会震动；iPhone 的浏览器不支持网页震动，只有动画
      try { if (navigator.vibrate) navigator.vibrate([80, 60, 160]); } catch (e) { /* 不支持就算了 */ }
      setTimeout(() => go(`#/materials?cheer=${btn.dataset.pid}`), 1500);
    }));
  }

  // ---------- 学习资料 ----------
  const MAT_SUBJECTS = SUBJECTS.concat([{ code: "other", name: "综合 / 其他" }]);
  function matSubjName(code) { const s = MAT_SUBJECTS.find((x) => x.code === code); return s ? s.name : code; }
  function fmtSize(n) {
    if (n == null) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }
  function readDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("读取文件失败"));
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    });
  }
  function materialCard(x) {
    const isFile = x.kind === "file";
    const href = isFile ? (RO ? x.path : `/api/materials/${x.id}/file`) : x.url;
    const meta = [x.by ? `${esc(x.by)} 分享` : "", esc(String(x.added_at || "").slice(0, 10)), isFile ? esc(fmtSize(x.size)) : "网盘 / 网页链接"].filter(Boolean).join(" · ");
    const open = x.missing
      ? `<span class="chip warn">本机文件丢失</span>`
      : `<a class="btn ${RO ? "primary" : ""}" href="${esc(href)}" ${isFile ? `download="${esc(x.name)}"` : `target="_blank" rel="noopener noreferrer"`}>${isFile ? "下载" : "打开链接"}</a>`;
    return `<div class="mat-item">
      <div class="mat-icon">${isFile ? esc((x.ext || String(x.name || "").split(".").pop() || "file").slice(0, 4).toUpperCase()) : "🔗"}</div>
      <div class="grow">
        <div class="mat-title"><b>${esc(x.title)}</b> <span class="chip">${esc(matSubjName(x.subject))}</span></div>
        ${x.note ? `<div class="mat-note">${esc(x.note)}</div>` : ""}
        <div class="muted small">${meta}${isFile && x.name ? ` · ${esc(x.name)}` : ""}</div>
      </div>
      <div class="mat-actions">${open}${RO ? "" : `<button class="btn ghost danger" data-del="${x.id}">删除</button>`}</div>
    </div>`;
  }

  async function renderMaterials(q) {
    const [m, info] = await Promise.all([api("GET", "/materials"), RO ? null : api("GET", "/publish")]);
    const filter = MAT_SUBJECTS.some((s) => s.code === q.get("s")) ? q.get("s") : "all";
    const cheerPid = q.get("cheer");
    const cheered = cheerPid && APP && APP.participants ? APP.participants.find((p) => String(p.id) === cheerPid) : null;
    const items = m.items.slice().reverse().filter((x) => filter === "all" || x.subject === filter);
    const counts = {};
    m.items.forEach((x) => { counts[x.subject] = (counts[x.subject] || 0) + 1; });
    const chips = [`<button data-s="all" class="${filter === "all" ? "on" : ""}">全部 ${m.items.length}</button>`]
      .concat(MAT_SUBJECTS.filter((s) => counts[s.code]).map((s) => `<button data-s="${s.code}" class="${filter === s.code ? "on" : ""}">${esc(s.name)} ${counts[s.code]}</button>`)).join("");
    const banner = cheered ? `<div class="note cheer-note">💪 你给 <b>${esc(cheered.nickname)}</b> 加了油！光喊不够，一起看看资料吧。</div>` : "";
    const list = items.length ? `<div class="mat-list">${items.map(materialCard).join("")}</div>`
      : `<div class="empty" style="padding:28px 8px"><h2 style="font-size:18px">${m.items.length ? "这一科还没有资料" : "还没有资料"}</h2><p class="muted">${RO ? "过几天再来看看，或者先分享你手里的好资料。" : "在右边添加第一份资料，然后发布给朋友。"}</p></div>`;
    const listCard = `<div class="card"><div class="card-head"><h3>资料（${m.items.length}）</h3></div>
      ${m.items.length ? `<div class="seg mat-filter" id="mat-seg">${chips}</div>` : ""}${list}</div>`;

    if (RO) {
      const share = m.collect_url
        ? `<div class="btns"><a class="btn lime" href="${esc(m.collect_url)}" target="_blank" rel="noopener noreferrer">📤 我也要分享资料</a></div>
           <p class="muted small">${m.collect_note ? esc(m.collect_note) : "点上面的按钮上传文件，整理好后会放到这里。"}</p>`
        : `<p class="muted small">${m.collect_note ? esc(m.collect_note) : "有好资料想分享？直接发给管理员，整理好后会放到这里。"}</p>`;
      view.innerHTML = `
        <section class="page-head"><div><h1>学习资料</h1><p>大家分享的学习资料，点“下载”保存到手机或电脑。</p></div></section>
        ${banner}
        <div class="poster-layout mat-layout">
          <div>${listCard}</div>
          <div class="side-panel"><div class="card"><div class="card-head"><h3>分享你的资料</h3></div>${share}</div></div>
        </div>`;
      wireMatFilter();
      return;
    }

    const s = info.settings;
    const ready = s.owner && s.repo && s.has_token;
    const pubText = m.published ? `朋友现在看到 ${m.published.count} 份资料（${esc(m.published.at.slice(5, 16))} 发布）。` : "还没有发布过资料。";
    const subjOpts = MAT_SUBJECTS.map((x) => `<option value="${x.code}">${esc(x.name)}</option>`).join("");
    view.innerHTML = `
      <section class="page-head"><div><h1>学习资料</h1><p>你添加的资料发布后，朋友在看板的“学习资料”页下载；朋友点“加油”后也会跳到这里。</p></div></section>
      ${banner}
      <div class="poster-layout mat-layout">
        <div>${listCard}</div>
        <div class="side-panel">
          <div class="card">
            <div class="card-head"><h3>添加资料</h3></div>
            <div class="stack">
              <label class="field"><span>标题</span><input type="text" id="mat-title" maxlength="60" placeholder="例如：第 3 周数学错题整理"></label>
              <label class="field"><span>科目</span><select id="mat-subject">${subjOpts}</select></label>
              <label class="field"><span>说明（可不填）</span><input type="text" id="mat-note" maxlength="300" placeholder="一句话说明这份资料"></label>
              <label class="field"><span>谁分享的（可不填）</span><input type="text" id="mat-by" maxlength="16" placeholder="朋友投稿的可以写上 TA 的昵称"></label>
              <div class="seg" id="mat-kind"><button data-k="file" class="on">上传文件</button><button data-k="link">网盘 / 网页链接</button></div>
              <label class="field" id="mat-file-wrap"><span>文件（最大 ${m.max_mb} MB）</span><input type="file" id="mat-file"></label>
              <label class="field" id="mat-url-wrap" hidden><span>链接</span><input type="text" id="mat-url" placeholder="https://…"></label>
              <div class="btns"><button class="btn primary" id="mat-add">添加</button></div>
              <p class="muted small">支持 PDF、Word、PPT、Excel、图片、压缩包、音视频等。超过 ${m.max_mb} MB 的请先传到网盘，再添加分享链接。添加后要点下面的“发布资料”朋友才看得到。</p>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><h3>发布给朋友</h3>${m.dirty ? `<span class="chip warn">有改动未发布</span>` : m.published ? `<span class="chip ok">已是最新</span>` : ""}</div>
            <div class="stack">
              <p class="muted small" style="margin:0">${pubText}资料单独发布，不会改动累计榜和战报。</p>
              ${ready ? "" : `<div class="note warn" style="margin:0">先在“发布给朋友”页填好 GitHub 仓库和令牌。</div>`}
              ${info.demo ? `<div class="note warn" style="margin:0">演示模式只能预览，不能发布。</div>` : ""}
              <div class="btns"><button class="btn" id="mat-preview">预览朋友看到的</button><button class="btn primary" id="mat-publish" ${ready && !info.demo ? "" : "disabled"}>发布资料</button></div>
              <div id="mat-result" class="small"></div>
              <p class="muted small" style="margin:0">发布的文件放在公开的 GitHub 仓库里，拿到网址的人都能下载，别放隐私资料和不能公开传播的东西。</p>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><h3>朋友怎么投稿</h3></div>
            <div class="stack">
              <p class="muted small" style="margin:0">朋友的网页不能直接收文件。建一个免费的收集链接（例如腾讯文档“收集表”加一道“上传文件”题），填在这里；朋友页面会出现“我也要分享资料”按钮。收到后你看一眼，再在上面添加、发布。</p>
              <label class="field"><span>收集链接</span><input type="text" id="mat-collect" placeholder="https://docs.qq.com/form/…" value="${esc(m.collect_url)}"></label>
              <label class="field"><span>给朋友的说明（可不填）</span><input type="text" id="mat-collect-note" maxlength="200" placeholder="例如：写上你的昵称，我整理后放上来" value="${esc(m.collect_note)}"></label>
              <div class="btns"><button class="btn" id="mat-collect-save">保存</button></div>
            </div>
          </div>
        </div>
      </div>`;
    wireMatFilter();
    let kind = "file";
    $all("#mat-kind button").forEach((b) => b.addEventListener("click", () => {
      kind = b.dataset.k;
      $all("#mat-kind button").forEach((x) => x.classList.toggle("on", x === b));
      $("#mat-file-wrap").hidden = kind !== "file";
      $("#mat-url-wrap").hidden = kind !== "link";
    }));
    $("#mat-add").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const body = { title: $("#mat-title").value, subject: $("#mat-subject").value, note: $("#mat-note").value, by: $("#mat-by").value };
      try {
        if (kind === "file") {
          const f = $("#mat-file").files[0];
          if (!f) throw new Error("请选择一个文件");
          if (f.size > m.max_mb * 1024 * 1024) throw new Error(`文件超过 ${m.max_mb} MB，请先放到网盘，再添加分享链接`);
          if (!$("#mat-title").value.trim()) $("#mat-title").value = body.title = f.name.replace(/\.[^.]+$/, "");
          btn.disabled = true;
          btn.textContent = "正在添加…";
          body.filename = f.name;
          body.file = await readDataUrl(f);
        } else {
          body.url = $("#mat-url").value;
        }
        await api("POST", "/materials", body);
        toast("已添加，记得点“发布资料”");
        route();
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
        btn.textContent = "添加";
      }
    });
    $all("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("删除这份资料？本机的文件也会删掉；朋友那边要等下次“发布资料”后才消失。")) return;
      try { await api("DELETE", `/materials/${b.dataset.del}`); toast("已删除"); route(); } catch (err) { toast(err.message, true); }
    }));
    $("#mat-collect-save").addEventListener("click", async () => {
      try {
        await api("PUT", "/materials/collect", { collect_url: $("#mat-collect").value, collect_note: $("#mat-collect-note").value });
        toast("已保存，发布资料后朋友那边生效");
        route();
      } catch (err) { toast(err.message, true); }
    });
    $("#mat-preview").addEventListener("click", async () => {
      const w = window.open("about:blank", "_blank");
      try {
        const r = await api("POST", "/publish/preview", { materials: true });
        if (w) w.location = r.url; else location.href = r.url;
      } catch (err) { if (w) w.close(); toast(err.message, true); }
    });
    $("#mat-publish").addEventListener("click", async (e) => {
      if (!confirm(`发布 ${m.items.length} 份资料？朋友那边的资料页会换成现在这个清单。`)) return;
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "正在上传…";
      try {
        const r = await api("POST", "/publish/materials", {});
        const msg = r.result.changed ? "资料已发布" : "内容和上次一样，无需更新";
        toast(msg);
        await route();
        $("#mat-result").innerHTML = `<div class="note">${msg}。朋友打开下面的网址就能看到（GitHub 一般 1–2 分钟内更新）。<div class="path">${esc(r.materials_url)}</div>${r.pages_enabled ? "" : "<b>还差一步：</b>到仓库 Settings → Pages，把 Source 设为 “Deploy from a branch”、分支选 main、目录 / (root)，保存。"}</div>`;
      } catch (err) {
        $("#mat-result").innerHTML = `<div class="note err">${esc(err.message)}</div>`;
        btn.disabled = false;
        btn.textContent = "发布资料";
      }
    });
  }
  function wireMatFilter() {
    $all("#mat-seg button").forEach((b) => b.addEventListener("click", () => go(b.dataset.s === "all" ? "#/materials" : `#/materials?s=${b.dataset.s}`)));
  }

  // ---------- 设置与备份 ----------
  function resizeAvatar(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\//.test(file.type)) return reject(new Error("请选择图片文件"));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("读取图片失败"));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("无法识别这张图片"));
        img.onload = () => {
          const size = 256;
          const c = document.createElement("canvas");
          c.width = size; c.height = size;
          const ctx = c.getContext("2d");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, size, size);
          const s = Math.min(img.naturalWidth, img.naturalHeight);
          ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
          resolve(c.toDataURL("image/jpeg", 0.9));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function renderSettings() {
    const users = people().map((p, idx) => `
      <div class="user-edit" data-pid="${p.id}">
        ${avatarHtml(p, idx, "lg")}
        <label class="field"><span>昵称（用户 ${idx + 1}）</span><input type="text" class="nick" maxlength="16" value="${esc(p.nickname)}"></label>
        <button class="btn save-nick">保存昵称</button>
        <label class="btn">上传头像<input type="file" accept="image/*" class="avatar-file" hidden></label>
        ${p.avatar ? `<button class="btn ghost clear-avatar">移除头像</button>` : ""}
      </div>`).join("");
    view.innerHTML = `
      <section class="page-head">
        <div><h1>设置与备份</h1><p>两位用户、数据位置、备份恢复与当前规则。</p></div>
      </section>
      <div class="settings-grid">
        <div class="card">
          <div class="card-head"><h3>两位用户</h3></div>
          ${users}
          <p class="muted small">修改昵称不会改变用户 ID，历史成绩和积分完整保留。头像只保存在本机数据库里。</p>
        </div>
        <div class="card">
          <div class="card-head"><h3>数据备份与恢复</h3></div>
          <div class="side-panel"><div class="stack" style="display:flex;flex-direction:column;gap:10px">
            <a class="btn primary" href="/api/backup" download>下载 JSON 备份</a>
            <button class="btn" id="save-backup">在 backups 文件夹保存一份备份</button>
            <label class="btn">从 JSON 备份恢复…<input type="file" accept="application/json,.json" id="restore-file" hidden></label>
            <div id="restore-msg" class="small"></div>
            <p class="muted small">恢复前会校验结构、成绩范围和每条结算积分；校验失败不会改动现有数据。恢复前会自动把当前数据备份到 backups 文件夹。</p>
          </div></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>数据保存位置</h3><span class="chip ${APP.demo ? "lime" : ""}">${APP.demo ? "演示模式" : "正式模式"}</span></div>
          <div class="muted small">数据库</div><div class="path">${esc(APP.paths.database)}</div>
          <div class="muted small" style="margin-top:8px">JPG 导出</div><div class="path">${esc(APP.paths.exports)}</div>
          <div class="muted small" style="margin-top:8px">备份</div><div class="path">${esc(APP.paths.backups)}</div>
          <div class="card-foot" style="margin-top:12px">
            <button class="btn" data-open="data">打开数据文件夹</button>
            <button class="btn" data-open="exports">打开导出文件夹</button>
            <button class="btn" data-open="backups">打开备份文件夹</button>
          </div>
        </div>
        <div class="card rules">
          <div class="card-head"><h3>当前规则</h3><span class="chip">${esc(APP.rule_version)}</span></div>
          <ul>
            <li>每周数学、英语、物理、化学各一次；满分 150 / 150 / 70 / 70，物理化学直接录入已赋分成绩。</li>
            <li><b>A 分差积分</b>：胜者得原始分差，败者 0，平局双方 0。</li>
            <li><b>C 联赛积分</b>：胜 3、平 1、负 0；分差 ≥ 满分 5% 额外 +1，≥ 10% 额外 +2（互斥）。</li>
            <li><b>缺考</b>：缺考者 A、C 都为 0；参考者 A 为 0、C 得 3（无奖励）。双方缺考均为 0。缺考不是 0 分。</li>
            <li><b>倍率</b>：周测 ×1，期中 ×2，其他特殊考试创建时选择。先算基础积分再乘倍率。</li>
            <li>两套积分分别累计、分别排名，永远不相加；累计包含本次已结算积分；同分并列。</li>
          </ul>
        </div>
      </div>`;

    $all(".user-edit").forEach((row) => {
      const pid = row.dataset.pid;
      $(".save-nick", row).addEventListener("click", async () => {
        try {
          await api("PATCH", `/participants/${pid}`, { nickname: $(".nick", row).value });
          toast("昵称已保存");
          route();
        } catch (e) { toast(e.message, true); }
      });
      $(".avatar-file", row).addEventListener("change", async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try {
          const data = await resizeAvatar(f);
          await api("PATCH", `/participants/${pid}`, { avatar: data });
          toast("头像已更新");
          route();
        } catch (err) { toast(err.message, true); }
      });
      const clr = $(".clear-avatar", row);
      if (clr) clr.addEventListener("click", async () => {
        await api("PATCH", `/participants/${pid}`, { clear_avatar: true });
        route();
      });
    });
    $("#save-backup").addEventListener("click", async () => {
      try {
        const r = await api("POST", "/backup/save");
        toast("备份已保存：" + r.path);
      } catch (e) { toast(e.message, true); }
    });
    $("#restore-file").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (!f) return;
      const msg = $("#restore-msg");
      let data;
      try {
        data = JSON.parse(await f.text());
      } catch (err) {
        msg.innerHTML = `<div class="note err">这个文件不是有效的 JSON。</div>`;
        return;
      }
      if (!confirm("恢复会用备份替换当前全部成绩与结算记录（当前数据会先自动备份）。继续吗？")) return;
      try {
        const r = await api("POST", "/restore", data);
        msg.innerHTML = `<div class="note">恢复成功。恢复前的数据已备份到：<div class="path">${esc(r.safety_backup)}</div></div>`;
        pref("event", "");
        await refreshState();
      } catch (err) {
        msg.innerHTML = `<div class="note err">${esc(err.message)}。当前数据没有改动。</div>`;
      }
    });
    $all("[data-open]").forEach((b) => b.addEventListener("click", () => api("POST", "/open-folder", { which: b.dataset.open }).catch((e) => toast(e.message, true))));
  }

  // ---------- 发布给朋友 ----------
  async function renderPublish() {
    const [info, rl] = await Promise.all([api("GET", "/publish"), api("GET", "/reports")]);
    const pubReports = rl.items.filter((x) => publishedParts(x).length).reverse();
    const latestReady = rl.items.filter((x) => reportViews(x).length).slice(-1)[0];
    const s = info.settings;
    const evs = info.events.slice().reverse();
    const evOpts = evs.map((e, i) => `<option value="${i === 0 ? "latest" : e.id}">截至 ${esc(e.label)}${i === 0 ? "（最新已结算）" : ""}${e.status === "dirty" ? " · 用上次结算的版本" : ""}</option>`).join("")
      + `<option value="none">清空：朋友那边暂时不显示任何成绩</option>`;
    const describe = (x) => (x && x.event_count ? `截至${x.cutoff_label}，共 ${x.event_count} 次考试（${x.at.slice(5, 16)} 发布）` : "还没有发布成绩（空白）");
    const last = s.last ? `朋友现在看到的：${esc(describe(s.last))}。` : "还没有发布过。";
    const ready = s.owner && s.repo && s.has_token;
    view.innerHTML = `
      <section class="page-head">
        <div><h1>发布给朋友</h1><p>朋友打开网址只能看榜和海报。只有你点“发布”后，已结算的成绩才会出现在那边。</p></div>
      </section>
      <div class="settings-grid">
        <div class="card">
          <div class="card-head"><h3>1 · GitHub 设置</h3>${ready ? `<span class="chip ok">已设置</span>` : `<span class="chip warn">未完成</span>`}</div>
          <div class="stack" style="display:flex;flex-direction:column;gap:10px">
            <label class="field"><span>仓库（用户名/仓库名）</span><input type="text" id="pub-repo" placeholder="例如 zhangsan/league-view" value="${esc(s.owner && s.repo ? s.owner + "/" + s.repo : "")}"></label>
            <label class="field"><span>分支</span><input type="text" id="pub-branch" value="${esc(s.branch)}"></label>
            <label class="field"><span>令牌（token）</span><input type="password" id="pub-token" autocomplete="off" placeholder="${s.has_token ? "已保存；留空表示不修改" : "粘贴 github_pat_ 开头的一串"}"></label>
            <div class="btns"><button class="btn primary" id="pub-save">保存设置</button>${s.has_token ? `<button class="btn ghost" id="pub-clear">删除已保存的令牌</button>` : ""}</div>
            <p class="muted small">令牌只保存在本机 data 文件夹里，不会进入备份，也不会发布出去。具体步骤见 app 文件夹里的《发布给朋友-设置步骤.md》。</p>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>2 · 发布</h3></div>
          <div class="stack" style="display:flex;flex-direction:column;gap:10px">
            ${evs.length ? "" : `<div class="note warn">还没有已结算的考试，现在只能发布“清空”。</div>`}
            <label class="field"><span>发布范围</span><select id="pub-cutoff">${evOpts}</select></label>
            <div class="note">会发布：两位用户的昵称和头像、范围内每次考试<b>已结算版本</b>的成绩、A/C 两套积分和排名。<br>不会发布：草稿、结算后还没重新结算的修改、备份、电脑上的文件路径。单科 / 整场战报单独发布，见下面第 3 步。</div>
            ${info.demo ? `<div class="note warn">现在是演示模式，只能预览，不能发布。发布真实成绩请用“启动.bat”。</div>` : ""}
            <div class="btns">
              <button class="btn" id="pub-preview">先预览朋友看到的页面</button>
              <button class="btn primary" id="pub-go" ${ready && !info.demo ? "" : "disabled"}>发布到 GitHub</button>
            </div>
            <div id="pub-result" class="small"></div>
            <p class="muted small">${last}</p>
            ${s.can_undo && ready && !info.demo ? `<div class="btns"><button class="btn ghost" id="pub-undo">撤回上一次发布</button></div>
            <p class="muted small">撤回后朋友会看到：${esc(describe(s.prev))}。只能撤回最近一次。</p>` : ""}
            ${s.site_url ? `<div class="muted small">朋友看的网址：</div><div class="path">${esc(s.site_url)}</div><div class="btns"><button class="btn ghost" id="pub-copy">复制网址</button></div>` : ""}
            <p class="muted small">发布后 GitHub 一般要 1–2 分钟才更新网页；第一次发布可能要等 5 分钟左右。</p>
          </div>
        </div>
        <div class="card" style="grid-column:1/-1">
          <div class="card-head"><h3>3 · 单科 / 整场战报</h3>${pubReports.length ? `<span class="chip ok">${pubReports.length} 场考试有已发布的战报</span>` : ""}</div>
          <div class="stack" style="display:flex;flex-direction:column;gap:10px">
            <p class="muted small" style="margin:0">某一科两个人的成绩出齐，就能只发布这一科的战报（原始分数、这一科的 A/C 积分），不用等整场结算；整场结算后还可以发布整场战报。朋友用单独的链接直接打开。和上面的累计榜分开：发布、撤下战报不会改动累计榜，上面的发布和撤回也不会动战报。</p>
            ${latestReady ? `<div class="btns"><a class="btn primary" href="#/report/${latestReady.id}">去发布最新一场：${esc(latestReady.label)} →</a><a class="btn ghost" href="#/report">全部场次</a></div>` : `<div class="note warn">还没有哪一科两个人的成绩都录完。</div>`}
            ${pubReports.length ? `<div class="report-list">${pubReports.map((it) => `<a class="report-row" href="#/report/${it.id}"><div class="grow"><b>${esc(it.label)}</b> <span class="muted small">${esc(it.exam_date)}</span></div>${reportChip(it)}<span class="go">→</span></a>`).join("")}</div>` : ""}
          </div>
        </div>
      </div>`;

    const cutoff = () => $("#pub-cutoff").value;
    $("#pub-save").addEventListener("click", async () => {
      try {
        await api("PUT", "/publish/settings", { repo: $("#pub-repo").value, branch: $("#pub-branch").value, token: $("#pub-token").value });
        toast("发布设置已保存");
        route();
      } catch (e) { toast(e.message, true); }
    });
    const clr = $("#pub-clear");
    if (clr) clr.addEventListener("click", async () => {
      if (!confirm("删除后需要重新粘贴令牌才能发布。继续吗？")) return;
      try {
        await api("PUT", "/publish/settings", { repo: $("#pub-repo").value, branch: $("#pub-branch").value, clear_token: true });
        route();
      } catch (e) { toast(e.message, true); }
    });
    $("#pub-preview").addEventListener("click", async () => {
      const w = window.open("about:blank", "_blank");
      try {
        const r = await api("POST", "/publish/preview", { cutoff: cutoff() });
        if (w) w.location = r.url; else location.href = r.url;
      } catch (e) {
        if (w) w.close();
        toast(e.message, true);
      }
    });
    $("#pub-go").addEventListener("click", async (e) => {
      const label = $("#pub-cutoff").selectedOptions[0].textContent;
      const question = cutoff() === "none"
        ? "确认清空？朋友那边会显示“还没有发布成绩”。"
        : `确认发布？朋友将看到${label.replace(/（.*?）/, "").replace(/ · .*$/, "")}的已结算成绩。`;
      if (!confirm(question)) return;
      await runPublish(e.currentTarget, "/publish", { cutoff: cutoff() }, cutoff() === "none" ? "已清空" : "发布成功");
    });
    const undo = $("#pub-undo");
    if (undo) undo.addEventListener("click", async (e) => {
      if (!confirm(`撤回上一次发布？朋友将看到：${describe(s.prev)}。`)) return;
      await runPublish(e.currentTarget, "/publish/undo", {}, "已撤回");
    });
    async function runPublish(btn, path, body, okText) {
      const text = btn.textContent;
      $all("#pub-go, #pub-undo").forEach((b) => { b.disabled = true; });
      btn.textContent = "正在上传…";
      try {
        const r = await api("POST", path, body);
        const msg = r.result.changed ? okText : "内容和上次一样，无需更新";
        toast(msg);
        await route();
        $("#pub-result").innerHTML = `<div class="note">${msg}。朋友刷新网页即可看到（GitHub 一般 1–2 分钟内更新）。<div class="path">${esc(r.url)}</div>${r.pages_enabled ? "" : "<b>还差一步：</b>到仓库 Settings → Pages，把 Source 设为 “Deploy from a branch”、分支选 main、目录 / (root)，保存。只需要做一次。"}</div>`;
      } catch (err) {
        $("#pub-result").innerHTML = `<div class="note err">${esc(err.message)}</div>`;
        $all("#pub-go, #pub-undo").forEach((b) => { b.disabled = false; });
        btn.textContent = text;
      }
    }
    const cp = $("#pub-copy");
    if (cp) cp.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(s.site_url); toast("网址已复制"); } catch (e) { toast("复制失败，请手动选中复制", true); }
    });
  }

  window.addEventListener("hashchange", route);
  route();
})();
