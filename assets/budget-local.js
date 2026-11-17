/* ============================================================
   📒 예닝 오피스 모바일 웹 — 가계부 "폰에서 바로 입력·수정·삭제"
   ------------------------------------------------------------
   서버가 없는 모바일 웹에서도 가계부를 쓸 수 있게 만드는 파일입니다.

   · POST /api/budget  → 이 파일이 받아서 localStorage('yening_budget_local_v1')에 즉시 저장
                        (entry · entry_del · split · finance · asset · asset_del · debt · debt_del)
   · GET  /api/budget  → PIN 스냅샷(PC budget.json)과 폰 저장분을 합쳐서 돌려준다
                        (중복 id 제거 · 지운 id 추적 · 월별 합계·카테고리·6개월 추이·
                         통장쪼개기·순자산·DSR 을 PC(app.py)와 같은 식으로 다시 계산)
   · CSV 내보내기 / JSON 백업 내보내기·가져오기 (PC budget.json 과 같은 형식)

   ※ 평문 개인 데이터는 이 파일에 없습니다. 저장은 그 폰 브라우저의 localStorage 에만 됩니다.
   ============================================================ */
(function () {
  "use strict";

  var KEY = "yening_budget_local_v1";
  var ACC_IDS = ["main", "living", "saving", "emergency"];
  var KIND_IDS = ["income", "fixed", "variable", "saving"];
  var KIND_NAME = { income: "수입", fixed: "고정지출", variable: "변동지출", saving: "저축" };
  var SEED_RATIOS = { main: 50, living: 30, saving: 15, emergency: 5 };
  var MAX_AMOUNT = 1e12;
  var MAX_ENTRIES = 5000;

  var DEFAULT_META = {
    kinds: [{ id: "income", name: "수입", sign: 1 },
            { id: "fixed", name: "고정지출", sign: -1 },
            { id: "variable", name: "변동지출", sign: -1 },
            { id: "saving", name: "저축", sign: -1 }],
    categories: {
      income: ["급여", "블로그 수익", "체험단", "부수입", "기타 수입"],
      fixed: ["주거/공과금", "통신", "보험", "교육/학원", "대출상환", "구독", "기타 고정"],
      variable: ["식비", "생활", "육아", "반려견", "쇼핑", "외식/카페", "병원/약국",
                 "교통/주유", "문화/여가", "경조사", "기타"],
      saving: ["예적금", "주식/펀드", "청약", "비상금", "연금", "기타 저축"]
    },
    methods: ["카드", "계좌이체", "현금", "상품권/포인트"],
    accounts: [{ id: "main", name: "월급 통장", role: "고정비" },
               { id: "living", name: "생활비 통장", role: "변동지출" },
               { id: "saving", name: "저축 통장", role: "저축·투자" },
               { id: "emergency", name: "비상금 통장", role: "비상금" }],
    assetTypes: ["예적금", "주식/펀드", "부동산", "기타"],
    debtTypes: ["주담대", "신용대출", "기타"]
  };

  /* ---------------- 작은 도구들 ---------------- */
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function thisMonthStr() { return todayStr().slice(0, 7); }
  function nowStr() {
    var d = new Date();
    return todayStr(d) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }
  function num(v) {
    var n = Number(String(v == null ? "" : v).replace(/,/g, "").replace(/원|%/g, "").trim());
    return isNaN(n) ? 0 : n;
  }
  function amount(v) {
    var n = Math.round(num(v));
    return Math.max(0, Math.min(MAX_AMOUNT, n));
  }
  function ratio(v) {
    var n = num(v);
    return Math.round(Math.max(0, Math.min(100, n)) * 100) / 100;
  }
  function r1(n) { return Math.round(n * 10) / 10; }          /* 소수 1자리 (pct·DSR) */
  function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "").trim()); }
  function str(v, max) { return String(v == null ? "" : v).trim().slice(0, max || 200); }
  function newId(prefix) {
    return (prefix || "b") + String(Date.now()) + String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  }
  function uniq(a) {
    var seen = {}, out = [];
    (a || []).forEach(function (x) { if (x != null && !seen[x]) { seen[x] = 1; out.push(x); } });
    return out;
  }

  /* ---------------- 저장소 (localStorage) ---------------- */
  function blankStore() {
    return { v: 1, entries: [], deletedEntries: [],
             split: null, finance: null,
             assets: [], debts: [], deletedAssets: [], deletedDebts: [],
             updated: "" };
  }

  function normEntry(x) {
    if (!x || typeof x !== "object") return null;
    var date = String(x.date || "").trim().slice(0, 10);
    if (!isDate(date)) return null;
    var kind = String(x.kind || "").trim();
    if (KIND_IDS.indexOf(kind) < 0) kind = "variable";
    return { id: str(x.id, 40) || newId("b"),
             date: date,
             kind: kind,
             category: str(x.category, 24) || "기타",
             method: str(x.method, 16) || "카드",
             amount: amount(x.amount),
             memo: str(x.memo, 200),
             updated: str(x.updated, 19) };
  }

  function normRow(x, isDebt) {
    if (!x || typeof x !== "object") return null;
    var row = { id: str(x.id, 40) || newId(isDebt ? "d" : "a"),
                name: str(x.name, 40) || (isDebt ? "부채" : "자산"),
                type: str(x.type, 16) || "기타",
                amount: amount(x.amount) };
    if (isDebt) row.rate = ratio(x.rate);
    return row;
  }

  function normStore(o) {
    var s = blankStore();
    if (!o || typeof o !== "object") return s;
    (o.entries || []).forEach(function (x) { var e = normEntry(x); if (e) s.entries.push(e); });
    (o.assets || []).forEach(function (x) { var e = normRow(x, false); if (e) s.assets.push(e); });
    (o.debts || []).forEach(function (x) { var e = normRow(x, true); if (e) s.debts.push(e); });
    s.deletedEntries = uniq((o.deletedEntries || []).map(function (x) { return str(x, 40); }).filter(Boolean));
    s.deletedAssets = uniq((o.deletedAssets || []).map(function (x) { return str(x, 40); }).filter(Boolean));
    s.deletedDebts = uniq((o.deletedDebts || []).map(function (x) { return str(x, 40); }).filter(Boolean));
    if (o.split && typeof o.split === "object") {
      var ratios = {};
      ACC_IDS.forEach(function (k) { ratios[k] = ratio((o.split.ratios || {})[k]); });
      s.split = { salary: amount(o.split.salary), ratios: ratios, updated: str(o.split.updated, 19) };
    }
    if (o.finance && typeof o.finance === "object") {
      s.finance = { annualIncome: amount(o.finance.annualIncome),
                    annualDebt: amount(o.finance.annualDebt),
                    updated: str(o.finance.updated, 19) };
    }
    s.updated = str(o.updated, 19);
    return s;
  }

  function loadStore() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { raw = null; }
    if (!raw) return blankStore();
    try { return normStore(JSON.parse(raw)); } catch (e) { return blankStore(); }
  }

  var storageOk = true;
  function saveStore(s) {
    s.updated = nowStr();
    var body = JSON.stringify({
      v: 1, updated: s.updated,
      entries: s.entries, deletedEntries: s.deletedEntries,
      split: s.split, finance: s.finance,
      assets: s.assets, debts: s.debts,
      deletedAssets: s.deletedAssets, deletedDebts: s.deletedDebts
    });
    try { localStorage.setItem(KEY, body); storageOk = true; return true; }
    catch (e) { storageOk = false; return false; }
  }

  function clearStore() {
    try { localStorage.removeItem(KEY); } catch (e) {}
  }

  /* ---------------- 병합 (PC 스냅샷 + 폰 저장분) ---------------- */
  function mergeRows(baseRows, localRows, deleted) {
    var map = {}, order = [];
    function put(x) {
      if (!x || !x.id) return;
      if (!(x.id in map)) order.push(x.id);
      map[x.id] = x;
    }
    (baseRows || []).forEach(put);
    (localRows || []).forEach(put);              /* 폰에서 고친 값이 이긴다 */
    (deleted || []).forEach(function (id) { delete map[id]; });
    return order.filter(function (id) { return map[id]; }).map(function (id) { return map[id]; });
  }

  function mergeBudgetBase(base, store) {
    base = base || {};
    var st = store || loadStore();

    var map = {}, order = [];
    function put(e) {
      if (!e || !e.id) return;
      if (!(e.id in map)) order.push(e.id);
      map[e.id] = e;
    }
    (base.entries || []).forEach(function (x) { var e = normEntry(x); if (e) put(e); });
    st.entries.forEach(put);
    st.deletedEntries.forEach(function (id) { delete map[id]; });
    var entries = order.filter(function (id) { return map[id]; }).map(function (id) { return map[id]; });

    var bsp = base.split || {};
    var splitRaw = st.split
      ? { salary: st.split.salary, ratios: st.split.ratios, updated: st.split.updated }
      : { salary: amount(bsp.salary),
          ratios: (function () {
            var r = {};
            ACC_IDS.forEach(function (k) { r[k] = ratio((bsp.ratios || {})[k]); });
            return r;
          })(),
          updated: str(bsp.updated, 19) };

    var bf = base.finance || {};
    var fin = {
      annualIncome: st.finance ? st.finance.annualIncome : amount(bf.annualIncome),
      annualDebt: st.finance ? st.finance.annualDebt : amount(bf.annualDebt),
      assets: mergeRows(bf.assets, st.assets, st.deletedAssets),
      debts: mergeRows(bf.debts, st.debts, st.deletedDebts),
      updated: st.finance ? st.finance.updated : str(bf.updated, 19)
    };

    return { entries: entries, split: splitRaw, finance: fin };
  }

  /* ---------------- PC(app.py)와 같은 계산 ---------------- */
  function splitView(sp) {
    sp = sp || {};
    var salary = amount(sp.salary);
    var ratios = {};
    ACC_IDS.forEach(function (k) { ratios[k] = ratio((sp.ratios || {})[k]); });
    var total = 0;
    ACC_IDS.forEach(function (k) { total += ratios[k]; });
    total = r2(total);
    var amounts = {};
    ACC_IDS.forEach(function (k) { amounts[k] = Math.round(salary * ratios[k] / 100); });
    if (Math.abs(total - 100) < 0.01 && salary > 0) {
      var others = 0;
      ACC_IDS.forEach(function (k) { if (k !== "emergency") others += amounts[k]; });
      amounts.emergency = Math.max(0, salary - others);
    }
    var sum = 0;
    ACC_IDS.forEach(function (k) { sum += amounts[k]; });
    return { salary: salary, ratios: ratios, amounts: amounts,
             totalPct: total, gap: r2(100 - total),
             valid: Math.abs(total - 100) < 0.01, sumAmounts: sum };
  }
  function r2(n) { return Math.round(n * 100) / 100; }

  function financeView(fin) {
    fin = fin || {};
    var assets = (fin.assets || []).map(function (x) { return normRow(x, false); }).filter(Boolean);
    var debts = (fin.debts || []).map(function (x) { return normRow(x, true); }).filter(Boolean);
    var assetTotal = 0, debtTotal = 0;
    assets.forEach(function (x) { assetTotal += x.amount; });
    debts.forEach(function (x) { debtTotal += x.amount; });
    var annualIncome = amount(fin.annualIncome), annualDebt = amount(fin.annualDebt);
    var dsr = annualIncome > 0 ? r1(annualDebt * 100 / annualIncome) : null;
    var debtRatio = assetTotal > 0 ? r1(debtTotal * 100 / assetTotal) : null;
    var grade, note;
    if (dsr == null) {
      grade = "확인 전";
      note = "연소득을 넣으면 DSR(총부채원리금상환비율)이 계산돼요.";
    } else if (dsr <= 30) {
      grade = "안정";
      note = "은행권 규제선 40% 안에서 여유가 있어요. (DSR " + dsr.toFixed(1) + "%)";
    } else if (dsr <= 40) {
      grade = "보통";
      note = "규제선 40%에 가까워요. 새 대출은 신중하게. (DSR " + dsr.toFixed(1) + "%)";
    } else if (dsr <= 50) {
      grade = "주의";
      note = "규제선 40%를 넘었어요. 상환 계획을 세워 주세요. (DSR " + dsr.toFixed(1) + "%)";
    } else {
      grade = "위험";
      note = "소득 대비 원리금 부담이 커요. (DSR " + dsr.toFixed(1) + "%)";
    }
    return { assets: assets, debts: debts, assetTotal: assetTotal, debtTotal: debtTotal,
             netWorth: assetTotal - debtTotal,
             annualIncome: annualIncome, annualDebt: annualDebt,
             dsr: dsr, debtRatio: debtRatio, grade: grade, note: note };
  }

  function monthRows(entries) {
    var months = {};
    entries.forEach(function (e) {
      var ym = e.date.slice(0, 7);
      var g = months[ym];
      if (!g) g = months[ym] = { income: 0, fixed: 0, variable: 0, saving: 0, count: 0, cats: {} };
      g.count += 1;
      g[e.kind] = (g[e.kind] || 0) + e.amount;
      if (e.kind === "fixed" || e.kind === "variable") {
        g.cats[e.category] = (g.cats[e.category] || 0) + e.amount;
      }
    });
    var keys = Object.keys(months).sort().reverse();
    var rows = keys.map(function (ym) {
      var g = months[ym];
      var expense = g.fixed + g.variable;
      var cats = Object.keys(g.cats).sort(function (a, b) { return g.cats[b] - g.cats[a]; })
        .map(function (c) {
          return { category: c, amount: g.cats[c],
                   pct: expense ? r1(g.cats[c] * 100 / expense) : 0 };
        });
      return { month: ym,
               income: g.income, fixed: g.fixed, variable: g.variable, expense: expense,
               saving: g.saving, balance: g.income - expense - g.saving,
               count: g.count, categories: cats,
               savingRate: g.income ? r1(g.saving * 100 / g.income) : 0 };
    });
    return { rows: rows, months: months };
  }

  function trend(months, now) {
    now = now || new Date();
    var out = [];
    for (var i = 5; i >= 0; i--) {
      var y = now.getFullYear(), m = now.getMonth() + 1 - i;
      while (m <= 0) { m += 12; y -= 1; }
      var ym = y + "-" + pad2(m);
      var g = months[ym] || {};
      out.push({ month: ym,
                 income: g.income || 0,
                 expense: (g.fixed || 0) + (g.variable || 0),
                 saving: g.saving || 0 });
    }
    return out;
  }

  function sortEntries(entries) {
    return entries.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return a.id < b.id ? 1 : (a.id > b.id ? -1 : 0);
    });
  }

  function buildPayload(base, store) {
    base = base || {};
    var merged = mergeBudgetBase(base, store);
    var sorted = sortEntries(merged.entries);
    var m = monthRows(sorted);
    var st = store || loadStore();
    return {
      ok: true,
      updated: st.updated || str(base.updated, 19),
      entries: sorted.slice(0, 1500),
      entryCount: sorted.length,
      months: m.rows,
      trend: trend(m.months),
      split: splitView(merged.split),
      finance: financeView(merged.finance),
      thisMonth: thisMonthStr(),
      local: { savedAt: st.updated,
               entries: st.entries.length,
               deleted: st.deletedEntries.length,
               assets: st.assets.length,
               debts: st.debts.length,
               storageOk: storageOk },
      meta: base.meta || DEFAULT_META
    };
  }

  /* ---------------- POST /api/budget 처리 ---------------- */
  function apply(body, base) {
    base = base || {};
    body = (body && typeof body === "object") ? body : {};
    var op = String(body.op || "entry").trim();
    var st = loadStore();
    var msg = "";
    var mergedEntries = mergeBudgetBase(base, st).entries;
    var known = {};
    mergedEntries.forEach(function (e) { known[e.id] = e; });

    if (op === "entry" || op === "entry_save") {
      var date = String(body.date || "").trim().slice(0, 10);
      if (!isDate(date)) return { ok: false, error: "날짜를 YYYY-MM-DD 형식으로 넣어 주세요." };
      var kind = String(body.kind || "").trim();
      if (KIND_IDS.indexOf(kind) < 0) return { ok: false, error: "구분은 수입·고정지출·변동지출·저축 중 하나여야 해요." };
      var amt = amount(body.amount);
      if (amt <= 0) return { ok: false, error: "금액을 1원 이상 넣어 주세요." };
      var eid = str(body.id, 40);
      var entry = normEntry({ id: eid || newId("b"), date: date, kind: kind,
                              category: body.category, method: body.method,
                              amount: amt, memo: body.memo, updated: nowStr() });
      var replaced = false;
      for (var i = 0; i < st.entries.length; i++) {
        if (st.entries[i].id === entry.id) { st.entries[i] = entry; replaced = true; break; }
      }
      if (!replaced) st.entries.push(entry);
      st.deletedEntries = st.deletedEntries.filter(function (x) { return x !== entry.id; });
      if (st.entries.length > MAX_ENTRIES) st.entries = st.entries.slice(-MAX_ENTRIES);
      msg = (eid && known[eid]) ? "내역을 고쳤어요" : "내역을 저장했어요";

    } else if (op === "entry_del" || op === "del") {
      var did = str(body.id, 40);
      if (!did || !known[did]) return { ok: false, error: "지울 내역을 찾지 못했어요 — 새로고침 후 다시 해 주세요." };
      var inBaseE = (base.entries || []).some(function (x) { return String(x.id) === did; });
      st.entries = st.entries.filter(function (x) { return x.id !== did; });
      /* PC 스냅샷에도 있는 id 라면 '지운 id'로 남겨 다시 나타나지 않게 한다 */
      if (inBaseE && st.deletedEntries.indexOf(did) < 0) st.deletedEntries.push(did);
      msg = "내역을 지웠어요";

    } else if (op === "split") {
      var salary = amount(body.salary);
      var ratios = {};
      var total = 0;
      ACC_IDS.forEach(function (k) { ratios[k] = ratio((body.ratios || {})[k]); total += ratios[k]; });
      total = r2(total);
      if (Math.abs(total - 100) >= 0.01) {
        return { ok: false, error: "비율 합계가 " + String(total) + "%예요 — 네 통장 비율을 꼭 100%로 맞춰 주세요." };
      }
      st.split = { salary: salary, ratios: ratios, updated: nowStr() };
      msg = "통장 배분을 저장했어요";

    } else if (op === "finance") {
      st.finance = { annualIncome: amount(body.annualIncome),
                     annualDebt: amount(body.annualDebt),
                     updated: nowStr() };
      msg = "연소득·연간 원리금을 저장했어요";

    } else if (op === "asset" || op === "asset_save" || op === "debt" || op === "debt_save") {
      var isDebt = op.indexOf("debt") === 0;
      var list = isDebt ? st.debts : st.assets;
      var name = str(body.name, 40);
      if (!name) return { ok: false, error: "이름을 먼저 적어 주세요 (예: 청년도약계좌)." };
      var row = normRow({ id: str(body.id, 40) || newId(isDebt ? "d" : "a"),
                          name: name, type: body.type, amount: body.amount, rate: body.rate }, isDebt);
      var repl = false;
      for (var j = 0; j < list.length; j++) {
        if (list[j].id === row.id) { list[j] = row; repl = true; break; }
      }
      if (!repl) list.push(row);
      if (isDebt) st.deletedDebts = st.deletedDebts.filter(function (x) { return x !== row.id; });
      else st.deletedAssets = st.deletedAssets.filter(function (x) { return x !== row.id; });
      msg = (isDebt ? "부채" : "자산") + (repl ? "를 고쳤어요" : "를 추가했어요");

    } else if (op === "asset_del" || op === "debt_del") {
      var isD = op.indexOf("debt") === 0;
      var dl = isD ? "debts" : "assets";
      var tid = str(body.id, 40);
      var baseList = (mergeBudgetBase(base, st).finance || {})[dl] || [];
      var found = baseList.some(function (x) { return x.id === tid; });
      if (!tid || !found) return { ok: false, error: "지울 항목을 찾지 못했어요." };
      var inBaseRow = ((base.finance || {})[dl] || []).some(function (x) { return String(x.id) === tid; });
      var cur = isD ? st.debts : st.assets;
      cur = cur.filter(function (x) { return x.id !== tid; });
      if (isD) { st.debts = cur; } else { st.assets = cur; }
      if (inBaseRow) {
        if (isD) { if (st.deletedDebts.indexOf(tid) < 0) st.deletedDebts.push(tid); }
        else { if (st.deletedAssets.indexOf(tid) < 0) st.deletedAssets.push(tid); }
      }
      msg = "지웠어요";

    } else {
      return { ok: false, error: "알 수 없는 요청이에요." };
    }

    if (!saveStore(st)) {
      return { ok: false, error: "이 브라우저에 저장하지 못했어요 — 시크릿 모드인지 확인해 주세요." };
    }
    return { ok: true, message: msg, budget: buildPayload(base, loadStore()) };
  }

  /* ---------------- JSON 백업 (PC budget.json 과 같은 형식) ---------------- */
  function exportObject(base) {
    var merged = mergeBudgetBase(base, loadStore());
    var st = loadStore();
    return {
      version: 1,
      exportedAt: nowStr(),
      exportedFrom: "예닝 오피스 모바일 (폰 저장분 + PC 스냅샷 병합)",
      entries: sortEntries(merged.entries),
      split: { salary: amount(merged.split.salary),
               ratios: (function () {
                 var r = {};
                 ACC_IDS.forEach(function (k) { r[k] = ratio((merged.split.ratios || {})[k]); });
                 return r;
               })(),
               updated: str(merged.split.updated, 19) },
      finance: { annualIncome: amount(merged.finance.annualIncome),
                 annualDebt: amount(merged.finance.annualDebt),
                 assets: merged.finance.assets,
                 debts: merged.finance.debts,
                 updated: str(merged.finance.updated, 19) },
      updated: st.updated || ""
    };
  }

  /* PC budget.json · 폰 백업 · /api/budget 응답 모두 받아들인다 */
  function importObject(obj, base) {
    if (!obj || typeof obj !== "object") return { ok: false, error: "JSON 파일을 읽지 못했어요." };
    base = base || {};
    var st = loadStore();
    var merged = mergeBudgetBase(base, st);
    var knownEntries = {}, knownAssets = {}, knownDebts = {};
    merged.entries.forEach(function (e) { knownEntries[e.id] = 1; });
    (merged.finance.assets || []).forEach(function (x) { knownAssets[x.id] = 1; });
    (merged.finance.debts || []).forEach(function (x) { knownDebts[x.id] = 1; });
    st.entries.forEach(function (e) { knownEntries[e.id] = 1; });

    var added = 0, skipped = 0;
    (obj.entries || []).forEach(function (x) {
      var e = normEntry(x);
      if (!e || knownEntries[e.id] || st.deletedEntries.indexOf(e.id) >= 0) { skipped += 1; return; }
      st.entries.push(e);
      knownEntries[e.id] = 1;
      added += 1;
    });

    var fin = obj.finance || {};
    ["assets", "debts"].forEach(function (key) {
      var isDebt = key === "debts";
      var known = isDebt ? knownDebts : knownAssets;
      var deleted = isDebt ? st.deletedDebts : st.deletedAssets;
      var target = isDebt ? st.debts : st.assets;
      (fin[key] || []).forEach(function (x) {
        var row = normRow(x, isDebt);
        if (!row || known[row.id] || deleted.indexOf(row.id) >= 0) { skipped += 1; return; }
        target.push(row);
        known[row.id] = 1;
        added += 1;
      });
    });

    if (!st.split && obj.split && obj.split.ratios) {
      var ratios = {}, tot = 0;
      ACC_IDS.forEach(function (k) { ratios[k] = ratio(obj.split.ratios[k]); tot += ratios[k]; });
      if (Math.abs(r2(tot) - 100) < 0.01) {
        st.split = { salary: amount(obj.split.salary), ratios: ratios, updated: nowStr() };
      }
    }
    var hasFin = (obj.finance && (num(obj.finance.annualIncome) || num(obj.finance.annualDebt)));
    var baseFin = base.finance || {};
    if (hasFin && !st.finance && !num(baseFin.annualIncome) && !num(baseFin.annualDebt)) {
      st.finance = { annualIncome: amount(obj.finance.annualIncome),
                     annualDebt: amount(obj.finance.annualDebt),
                     updated: nowStr() };
    }

    if (!saveStore(st)) return { ok: false, error: "이 브라우저에 저장하지 못했어요." };
    return { ok: true, added: added, skipped: skipped,
             message: "가져왔어요 · 새로 " + added + "건" + (skipped ? " (이미 있는 " + skipped + "건은 건너뜀)" : "") };
  }

  /* ---------------- 내려받기 ---------------- */
  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || "application/json;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 5000);
  }

  /* ---------------- 화면 (배지·백업 버튼·저장 표시) ---------------- */
  var baseSnapshot = null;      /* 마지막 GET /api/budget 의 PC 스냅샷 */

  function stamp() {
    var el = document.querySelector("#bgStamp");
    if (!el) return;
    var st = loadStore();
    var n = st.entries.length;
    el.style.color = "";
    el.textContent = "📱 폰에 자동 저장됨" +
      (st.updated ? " · 마지막 " + String(st.updated).slice(5, 16) : "") +
      (n ? " · 폰에서 적은 " + n + "건" : "");
  }

  function toastSafe(t) {
    try { if (window.toast) window.toast(t); } catch (e) {}
  }

  function installUi() {
    if (!document.querySelector("#pane-budget")) return;

    /* "보기 전용" 칩 → 폰 저장 배지 */
    var chip = document.querySelector("#pane-budget .bgmob");
    if (chip) chip.textContent = "📱 폰에 자동 저장됨";

    /* 저장 상태 문구는 앱이 덮어쓰므로 한 겹 감싼다 */
    if (typeof window.bgState === "function" && !window.bgState.__yb) {
      var origState = window.bgState;
      var wrapped = function (t, bad) {
        if (bad) { if (origState) origState(t, true); return; }
        stamp();
      };
      wrapped.__yb = true;
      window.bgState = wrapped;
    }
    if (typeof window.applyBudget === "function" && !window.applyBudget.__yb) {
      var origApply = window.applyBudget;
      var wrappedApply = function () {
        var r = origApply.apply(this, arguments);
        try { stamp(); } catch (e) {}
        return r;
      };
      wrappedApply.__yb = true;
      window.applyBudget = wrappedApply;
    }

    /* 백업 도구 줄 — 보는 달 바 아래에 붙인다 */
    if (!document.querySelector("#bgBackTools")) {
      var bar = document.querySelector("#pane-budget .bgbar");
      var tools = document.createElement("div");
      tools.className = "bgback";
      tools.id = "bgBackTools";
      tools.innerHTML =
        '<button class="btn small" id="bgJsonOut" type="button" title="폰 저장분 + PC 스냅샷을 PC budget.json 과 같은 형식으로 내려받아요">💾 JSON 백업 내려받기</button>' +
        '<button class="btn small" id="bgJsonIn" type="button" title="PC 에서 내려받은 budget.json 이나 폰 백업 JSON 을 가져와요">📤 JSON 가져오기</button>' +
        '<input type="file" id="bgJsonFile" accept=".json,application/json" hidden>' +
        '<span class="bgbacknote" id="bgLocalNote">폰 저장분과 PC 스냅샷을 합쳐 보여 줘요</span>';
      if (bar && bar.parentNode) bar.parentNode.insertBefore(tools, bar.nextSibling);
      else document.querySelector("#pane-budget").prepend(tools);

      var out = document.querySelector("#bgJsonOut");
      if (out) out.onclick = function () {
        try {
          var obj = exportObject(baseSnapshot);
          download("예닝_가계부_백업_" + todayStr() + ".json",
                   JSON.stringify(obj, null, 2), "application/json;charset=utf-8");
          toastSafe("💾 JSON 백업 " + obj.entries.length + "건 내려받았어요 — PC budget.json 과 같은 형식이에요");
        } catch (e) { toastSafe("백업 파일을 만들지 못했어요"); }
      };

      var fin = document.querySelector("#bgJsonIn");
      var file = document.querySelector("#bgJsonFile");
      if (fin && file) {
        fin.onclick = function () { file.click(); };
        file.onchange = function () {
          var f = file.files && file.files[0];
          if (!f) return;
          var reader = new FileReader();
          reader.onload = function () {
            var out2;
            try { out2 = importObject(JSON.parse(String(reader.result || "")), baseSnapshot); }
            catch (e) { out2 = { ok: false, error: "JSON 을 읽지 못했어요 — 파일이 맞는지 확인해 주세요." }; }
            file.value = "";
            if (!out2.ok) { toastSafe("⚠️ " + out2.error); return; }
            if (typeof window.loadBudget === "function") window.loadBudget();
            else stamp();
            toastSafe("📤 " + out2.message);
          };
          reader.readAsText(f, "utf-8");
        };
      }
    }

    /* 입력폼을 보는 달 바 아래로 올려 — 폰에서 열면 바로 금액을 적을 수 있게 */
    try {
      var pane = document.querySelector("#pane-budget .panel") || document.querySelector("#pane-budget");
      var form = document.querySelector("#bgForm");
      var anchor = document.querySelector("#bgBackTools") || document.querySelector("#pane-budget .bgbar");
      if (pane && form && anchor && anchor.parentNode === pane &&
          window.matchMedia && window.matchMedia("(max-width:820px)").matches) {
        pane.insertBefore(form, anchor.nextSibling);
      }
    } catch (e) {}

    /* 가계부 탭을 누르면 패널을 화면 위로 끌어올려 — 머리말·소품을 지나 스크롤하지 않게 */
    try {
      var tabBtn = document.querySelector('#tabs .tab[data-tab="budget"]');
      if (tabBtn && !tabBtn.__yb) {
        tabBtn.__yb = true;
        tabBtn.addEventListener("click", function () {
          if (!window.matchMedia || !window.matchMedia("(max-width:820px)").matches) return;
          setTimeout(function () {
            var pane = document.querySelector("#pane-budget");
            if (pane && pane.scrollIntoView) pane.scrollIntoView({ behavior: "smooth", block: "start" });
          }, 80);
        });
      }
    } catch (e) {}

    /* 첫 화면에도 배지가 보이도록 */
    setTimeout(function () { try { stamp(); } catch (e) {} }, 40);
  }

  /* ---------------- 내보내기 ---------------- */
  var YB = {
    KEY: KEY,
    load: loadStore,
    save: saveStore,
    clear: clearStore,
    normalize: normStore,
    mergeBudget: mergeBudgetBase,
    merge: function (base) {
      baseSnapshot = base || null;
      return buildPayload(base || {}, loadStore());
    },
    apply: apply,
    payload: buildPayload,
    exportObject: exportObject,
    importObject: importObject,
    monthRows: monthRows,
    splitView: splitView,
    financeView: financeView,
    trend: trend,
    amount: amount,
    ratio: ratio,
    get base() { return baseSnapshot; },
    installUi: installUi
  };
  window.YeningBudget = YB;
  window.YB = YB;

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installUi);
    else installUi();
    window.addEventListener("load", function () { try { stamp(); } catch (e) {} });
  }
})();
