/* ============================================================
   🎬 릴스 스튜디오 — 모바일 저장(localStorage)
   ------------------------------------------------------------
   PC 는 reels_profiles.json · reels_history.json 에 저장하지만
   폰에는 서버가 없으므로, 이 파일이 두 API 를 폰 저장으로 대신한다.

   - GET  /api/reels/profiles : PC 스냅샷 + 폰에서 고친 캐릭터 외형·스타일
   - GET  /api/reels/history  : PC 스냅샷 + 폰에서 담은 영상 + 상태·URL 변경
   - POST /api/reels/profiles : 고른 블로그의 캐릭터 외형·영상 스타일 저장
   - POST /api/reels/history  : 담기(add) · 상태(status) · 주소(url) · 삭제(delete)
   - 영상 프롬프트·자막 생성은 앱의 reelsPlanLocal 이 그 자리에서 만든다(서버 불필요).

   저장 키: yening_reels_local_v1
   ============================================================ */
(function () {
  "use strict";
  var KEY = "yening_reels_local_v1";
  var MAX_ROWS = 80;

  function read() {
    var o = null;
    try { o = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { o = null; }
    if (!o || typeof o !== "object") o = {};
    if (!o.profiles || typeof o.profiles !== "object") o.profiles = {};
    if (!Array.isArray(o.rows)) o.rows = [];
    if (!o.patch || typeof o.patch !== "object") o.patch = {};
    if (!Array.isArray(o.hidden)) o.hidden = [];
    return o;
  }
  function write(o) {
    try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {}
  }
  function p2(n) { return (n < 10 ? "0" : "") + n; }
  function stamp() {
    var d = new Date();
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + " " +
           p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds());
  }
  function data() {
    try { if (typeof REELS_DATA !== "undefined" && REELS_DATA) return REELS_DATA; } catch (e) {}
    return {};
  }
  function statuses() {
    var out = {};
    (data().statuses || []).forEach(function (s) { out[s.key] = s.label; });
    if (!out.waiting) { out.waiting = "제작 대기"; out.making = "제작 중"; out.uploaded = "업로드 완료"; }
    return out;
  }
  function blogOf(id) { return (data().blogs || {})[id] || null; }
  function en(v, def) {
    var raw = String(v == null ? "" : v).trim();
    if (!raw) return { text: def, korean: false };
    var keep = [], dropped = 0;
    raw.split(/\n+/).forEach(function (line) {
      var s = line.trim();
      if (!s) return;
      if (/[\uAC00-\uD7A3]/.test(s)) { dropped++; return; }
      keep.push(s);
    });
    if (!keep.length) return { text: def, korean: true };
    return { text: keep.join(" "), korean: dropped > 0 };
  }
  function cleanUrl(u) {
    var s = String(u == null ? "" : u).trim().slice(0, 300);
    if (!s) return "";
    if (!/^https?:\/\//i.test(s)) {
      if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(s)) s = "https://" + s;
      else return "";
    }
    return s;
  }
  function space(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
  function sameTitle(a, b) { return space(a) === space(b); }

  /* ---------------- 🎭 블로그별 캐릭터 외형 · 영상 스타일 ---------------- */
  function mergeProfiles(snap) {
    var loc = read();
    var out = snap ? JSON.parse(JSON.stringify(snap)) : { ok: true, blogs: [] };
    out.ok = true;
    out.blogs = out.blogs || [];
    out.order = out.order || (data().order || []);
    (out.blogs || []).forEach(function (b) {
      var d = blogOf(b.id) || {};
      if (!b.defaultCharacter) b.defaultCharacter = d.character || "";
      if (!b.defaultStyle) b.defaultStyle = d.style || "";
      var row = loc.profiles[b.id];
      if (!row) return;
      var rawc = String(row.character == null ? "" : row.character).slice(0, 400);
      var raws = String(row.style == null ? "" : row.style).slice(0, 400);
      var ch = en(rawc, b.defaultCharacter);
      var st = en(raws, b.defaultStyle);
      b.characterRaw = rawc;
      b.styleRaw = raws;
      b.character = ch.text;
      b.style = st.text;
      b.custom = !!(rawc.trim() || raws.trim());
      b.koreanInPrompt = !!(ch.korean || st.korean);
    });
    var baseSet = out.settings && typeof out.settings === "object" ? out.settings : (data().defaults || {});
    if (loc.settings && typeof loc.settings === "object") {
      out.settings = {
        monthlyCredit: (loc.settings.monthlyCredit !== undefined ? loc.settings.monthlyCredit : baseSet.monthlyCredit),
        perVideoCredit: (loc.settings.perVideoCredit !== undefined ? loc.settings.perVideoCredit : baseSet.perVideoCredit),
        defaults: baseSet.defaults || data().defaults || {}
      };
    }
    out.updated = loc.updated || out.updated || "";
    out.mobile = true;
    return out;
  }

  function saveProfiles(body, snap) {
    body = body || {};
    var loc = read();
    if (body.settings && typeof body.settings === "object") {
      var cur0 = loc.settings || {};
      var m = Number(body.settings.monthlyCredit), p = Number(body.settings.perVideoCredit);
      if (isFinite(m) && m >= 0) cur0.monthlyCredit = Math.min(1000000, Math.round(m));
      if (isFinite(p) && p >= 1) cur0.perVideoCredit = Math.min(100000, Math.round(p));
      loc.settings = cur0;
      loc.updated = stamp();
      write(loc);
      var out0 = mergeProfiles(snap || {});
      out0.changed = ["settings"];
      out0.msg = "폰에 크레딧 설정을 저장했어요.";
      return out0;
    }
    var bid = String(body.blog || "");
    if (!blogOf(bid)) return { ok: false, error: "저장할 블로그를 찾지 못했어요." };
    if (body.reset) {
      delete loc.profiles[bid];
    } else {
      var cur = loc.profiles[bid] || {};
      if (body.character !== undefined && body.character !== null)
        cur.character = String(body.character || "").trim().slice(0, 400);
      if (body.style !== undefined && body.style !== null)
        cur.style = String(body.style || "").trim().slice(0, 400);
      loc.profiles[bid] = cur;
    }
    loc.updated = stamp();
    write(loc);
    var out = mergeProfiles(snap || {});
    out.changed = [bid];
    out.msg = body.reset ? "폰에서 기본 외형·스타일로 되돌렸어요." : "폰에 저장했어요 — 다음 영상부터 적용돼요.";
    return out;
  }

  /* ---------------- 🎞 제작 이력 ---------------- */
  function normalize(row) {
    if (!row || !row.blog || !blogOf(row.blog)) return null;
    var ST = statuses();
    var status = ST[row.status] ? row.status : "waiting";
    var plan = (row.plan && typeof row.plan === "object") ? row.plan : {};
    return {
      id: String(row.id || ""),
      blog: row.blog,
      blogName: row.blogName || (blogOf(row.blog) || {}).label || row.blog,
      title: space(row.title).slice(0, 140),
      category: row.category || plan.category || "",
      categoryLabel: row.categoryLabel || plan.categoryLabel || "",
      status: status,
      statusLabel: ST[status],
      aiSetting: !!row.aiSetting,
      url: cleanUrl(row.url),
      note: String(row.note || "").slice(0, 200),
      created: String(row.created || "").slice(0, 19),
      updated: String(row.updated || row.created || "").slice(0, 19),
      plan: plan,
      subtitle: (plan.subtitle && typeof plan.subtitle === "object") ? plan.subtitle : {},
      hasPrompts: !!(plan.cut1Prompt && plan.cut2Prompt),
      mobile: true
    };
  }

  function mergeHistory(snap) {
    var loc = read();
    var rows = [];
    ((snap && snap.rows) || []).forEach(function (r) {
      var n = normalize(r);
      if (n) rows.push(n);
    });
    // 폰에서 바꾼 상태·주소·프롬프트를 PC 스냅샷 행에 덮어쓴다
    Object.keys(loc.patch).forEach(function (id) {
      var p = loc.patch[id] || {};
      rows.forEach(function (r) {
        if (r.id !== id) return;
        if (p.status) { r.status = p.status; r.statusLabel = statuses()[p.status] || r.statusLabel; }
        if (p.aiSetting !== undefined) r.aiSetting = !!p.aiSetting;
        if (p.url !== undefined) r.url = cleanUrl(p.url);
        if (p.note !== undefined) r.note = String(p.note || "").slice(0, 200);
        if (p.plan) {
          r.plan = p.plan;
          r.subtitle = (p.plan.subtitle && typeof p.plan.subtitle === "object") ? p.plan.subtitle : {};
          r.hasPrompts = !!(p.plan.cut1Prompt && p.plan.cut2Prompt);
          if (p.plan.category) r.category = p.plan.category;
          if (p.plan.categoryLabel) r.categoryLabel = p.plan.categoryLabel;
        }
        if (p.updated) r.updated = p.updated;
      });
    });
    loc.rows.forEach(function (r) {
      var n = normalize(r);
      if (n && (n.status || n.plan)) rows.push(n);
    });
    rows = rows.filter(function (r) { return loc.hidden.indexOf(r.id) < 0 && r.id && r.title; });
    rows.sort(function (a, b) {
      var A = (a.updated || "") + (a.created || ""), B = (b.updated || "") + (b.created || "");
      return A < B ? 1 : (A > B ? -1 : 0);
    });
    // 같은 블로그·같은 제목이 두 번 잡히면 최신 것만 남긴다(중복 방지)
    var seen = {}, out = [];
    rows.forEach(function (r) {
      var k = r.blog + "|" + space(r.title) + "|" + r.status;
      if (seen[k]) return;
      seen[k] = 1;
      out.push(r);
    });
    out = out.slice(0, MAX_ROWS);
    return { ok: true, rows: out, count: out.length, mobile: true,
             updated: loc.updated || "", statuses: data().statuses || [] };
  }

  function findRow(snap, id) {
    var rows = mergeHistory(snap).rows;
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
    return null;
  }

  function planFor(body) {
    if (body.cut1Prompt && body.cut2Prompt) {
      var sub = (body.subtitle && typeof body.subtitle === "object") ? body.subtitle : {};
      return { ok: true, blog: body.blog, blogName: (blogOf(body.blog) || {}).label || body.blog,
               emoji: (blogOf(body.blog) || {}).emoji || "", concept: "", title: space(body.title),
               category: body.category || "", categoryLabel: body.categoryLabel || "",
               cut1Prompt: body.cut1Prompt, cut2Prompt: body.cut2Prompt,
               promptFull: [data().header, body.cut1Prompt, body.cut2Prompt, data().tail].join("\n\n"),
               header: data().header, tail: data().tail, noAudio: data().noAudio,
               subtitle: sub, rules: { cuts: 2, aspect: "9:16", silent: true }, warnings: [],
               generatedBy: "mobile" };
    }
    if (typeof window.reelsPlanLocal === "function") {
      try { return window.reelsPlanLocal(body); } catch (e) { return { ok: false, error: "프롬프트를 만들지 못했어요" }; }
    }
    return { ok: false, error: "이 화면에서는 프롬프트를 만들 수 없어요." };
  }

  function historyOp(body, snap) {
    body = body || {};
    var op = String(body.op || "");
    var loc = read();
    var ST = statuses();
    var now = stamp();
    var out;

    if (op === "skip") {
      var sbid = String(body.blog || "");
      var stitle = space(body.title).slice(0, 140);
      if (!blogOf(sbid)) return { ok: false, error: "AI 영상 제작은 5개 네이버 블로그만 지원해요." };
      if (!stitle) return { ok: false, error: "건너뛸 글 제목이 없어요." };
      var srow = null;
      mergeHistory(snap).rows.forEach(function (r) {
        if (!srow && r.blog === sbid && sameTitle(r.title, stitle)) srow = r;
      });
      var localRow = srow && loc.rows.some(function (r) { return r.id === srow.id; });
      if (srow && localRow) {
        loc.rows.forEach(function (r) { if (r.id === srow.id) { r.status = "skipped"; r.updated = now; } });
      } else if (srow) {
        var sp = loc.patch[srow.id] || {};
        sp.status = "skipped"; sp.updated = now;
        loc.patch[srow.id] = sp;
      } else {
        loc.rows.unshift({ id: "rlm" + String(Date.now()), blog: sbid, blogName: (blogOf(sbid) || {}).label || sbid,
                           title: stitle, category: "", categoryLabel: "", status: "skipped", url: "",
                           note: "", created: now, updated: now, plan: {}, subtitle: {}, hasPrompts: false });
        if (loc.rows.length > MAX_ROWS) loc.rows = loc.rows.slice(0, MAX_ROWS);
      }
      loc.updated = now;
      write(loc);
      out = mergeHistory(snap);
      out.skipped = stitle;
      return out;
    }

    if (op === "add") {
      var bid = String(body.blog || "");
      var title = space(body.title).slice(0, 140);
      if (!blogOf(bid)) { out = { ok: false, error: "AI 영상 제작은 5개 네이버 블로그만 지원해요." }; return out; }
      if (!title) { out = { ok: false, error: "영상으로 만들 효자글 제목이 없어요." }; return out; }
      var plan = planFor({ blog: bid, title: title, category: body.category || "",
                           categoryLabel: body.categoryLabel || "", core: body.core || "",
                           cut1Prompt: body.cut1Prompt, cut2Prompt: body.cut2Prompt,
                           subtitle: body.subtitle });
      if (!plan || !plan.ok) return plan || { ok: false, error: "프롬프트를 만들지 못했어요." };
      var exist = null;
      mergeHistory(snap).rows.forEach(function (r) {
        if (!exist && r.blog === bid && sameTitle(r.title, title) && r.status !== "uploaded") exist = r;
      });
      if (exist) {
        var isLocal = loc.rows.some(function (r) { return r.id === exist.id; });
        if (isLocal) {
          loc.rows.forEach(function (r) {
            if (r.id !== exist.id) return;
            r.plan = plan; r.category = plan.category || r.category; r.categoryLabel = plan.categoryLabel || "";
            r.updated = now;
          });
        } else {
          var p = loc.patch[exist.id] || {};
          p.plan = plan; p.updated = now;
          loc.patch[exist.id] = p;
        }
        out = mergeHistory(snap);
        out.created = false;
        out.row = findRow(snap, exist.id);
      } else {
        var row = { id: "rlm" + String(Date.now()), blog: bid, blogName: (blogOf(bid) || {}).label || bid,
                    title: title, category: plan.category || "", categoryLabel: plan.categoryLabel || "",
                    status: "waiting", url: "", note: "", created: now, updated: now,
                    plan: plan, subtitle: plan.subtitle || {}, hasPrompts: !!(plan.cut1Prompt && plan.cut2Prompt) };
        loc.rows.unshift(row);
        if (loc.rows.length > MAX_ROWS) loc.rows = loc.rows.slice(0, MAX_ROWS);
        out = mergeHistory(snap);
        out.created = true;
        out.row = findRow(snap, row.id);
      }
      loc.updated = now;
      write(loc);
      return out;
    }

    if (op === "status" || op === "url" || op === "note" || op === "delete") {
      var id = String(body.id || "");
      var target = findRow(snap, id);
      if (!target) return { ok: false, error: "이력에서 그 영상을 찾지 못했어요." };
      if (op === "delete") {
        loc.rows = loc.rows.filter(function (r) { return r.id !== id; });
        if (loc.hidden.indexOf(id) < 0) loc.hidden.push(id);
        delete loc.patch[id];
        loc.updated = now;
        write(loc);
        out = mergeHistory(snap);
        out.deleted = id;
        return out;
      }
      var patch = loc.patch[id] || {};
      var inLocal = loc.rows.some(function (r) { return r.id === id; });
      if (op === "status") {
        var st = String(body.status || "");
        if (!ST[st]) return { ok: false, error: "상태는 제작 대기·제작 중·업로드 완료 중 하나예요." };
        var ai = body.aiSetting === undefined ? undefined : !!body.aiSetting;
        if (inLocal) loc.rows.forEach(function (r) { if (r.id === id) { r.status = st; r.updated = now; if (ai !== undefined) r.aiSetting = ai; } });
        else { patch.status = st; patch.updated = now; if (ai !== undefined) patch.aiSetting = ai; }
      } else if (op === "url") {
        var raw = String(body.url || "").trim();
        var cu = cleanUrl(raw);
        if (raw && !cu) return { ok: false, error: "주소 형식이 아니어서 저장하지 않았어요: " + raw.slice(0, 60) };
        if (inLocal) loc.rows.forEach(function (r) { if (r.id === id) { r.url = cu; r.updated = now; } });
        else { patch.url = cu; patch.updated = now; }
      } else {
        if (inLocal) loc.rows.forEach(function (r) { if (r.id === id) { r.note = String(body.note || "").slice(0, 200); r.updated = now; } });
        else { patch.note = String(body.note || "").slice(0, 200); patch.updated = now; }
      }
      if (!inLocal) loc.patch[id] = patch;
      loc.updated = now;
      write(loc);
      out = mergeHistory(snap);
      if (op === "status" && body.status === "uploaded" && !findRow(snap, id).url)
        out.warning = "업로드 완료로 바꿨어요 — 영상 주소(URL)를 아직 안 넣었어요.";
      return out;
    }

    return { ok: false, error: "알 수 없는 요청이에요." };
  }

  window.YR = {
    mergeProfiles: mergeProfiles,
    saveProfiles: saveProfiles,
    mergeHistory: mergeHistory,
    historyOp: historyOp,
    read: read,
    KEY: KEY
  };
})();
