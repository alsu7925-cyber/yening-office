/* ============================================================
   📱 예닝 오피스 모바일 웹 — PIN 잠금 + 데이터 복호화 + 가계부 폰 저장
   ------------------------------------------------------------
   - data.enc.json 은 PBKDF2(PIN, SHA-256, 15만 회) + AES-GCM-256 으로 암호화되어 있다.
   - PIN 이 맞아야만 복호화되고, 그 안의 스냅샷이 앱의 /api/* 응답을 대신한다.
   - 📒 가계부(/api/budget)만 예외로, GET 은 스냅샷+폰 저장분을 병합하고
     POST 는 budget-local.js 가 localStorage 에 저장한다(나머지 탭은 여전히 읽기 전용).
   - 평문 개인 데이터·API 키는 이 페이지 어디에도 들어가지 않는다.
   ============================================================ */
(function () {
  "use strict";

  var LOCK_ID = "lockScreen";
  var KEEP_KEY = "yening_office_key";     /* {k: base64 raw key, exp: ms} */
  var SESSION_KEY = "yening_office_key_s";
  var realFetch = window.fetch ? window.fetch.bind(window) : null;

  var ENC = null;                          /* data.enc.json 원본 */
  var pinBuf = "";
  var busy = false;

  window.__OFFICE_META = null;
  window.__OFFICE_DATA = null;
  window.__OFFICE_READY = new Promise(function (res) { window.__PIN_READY_RESOLVE = res; });

  /* 예전 PC 탭 기억(office_tab)이 모바일 웹에 남아 'miner' 로 열리는 일 방지 */
  try {
    if (localStorage.getItem("office_tab") === "miner") localStorage.setItem("office_tab", "office");
  } catch (e) {}

  function $(s) { return document.querySelector(s); }
  function b64ToBuf(b64) {
    var bin = atob(b64), len = bin.length, out = new Uint8Array(len);
    for (var i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bufToB64(buf) {
    var bytes = new Uint8Array(buf), s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function enc(str) { return new TextEncoder().encode(str); }

  function deriveKey(pin, salt, iter, extractable) {
    return crypto.subtle.importKey("raw", enc(String(pin)), "PBKDF2", false, ["deriveKey"])
      .then(function (km) {
        return crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: salt, iterations: iter, hash: "SHA-256" },
          km, { name: "AES-GCM", length: 256 }, !!extractable, ["decrypt"]);
      });
  }
  function decryptWith(key, iv, ct) {
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, ct);
  }

  /* ---------------- 잠금 화면 ---------------- */
  function buildLock() {
    if ($("#" + LOCK_ID)) return;
    var wrap = document.createElement("div");
    wrap.id = LOCK_ID;
    wrap.innerHTML =
      '<div class="lk-card">' +
        '<div class="lk-logo">🏢</div>' +
        '<div class="lk-title">예닝 오피스</div>' +
        '<div class="lk-sub">대표님 전용 · PIN 4자리를 눌러 주세요</div>' +
        '<div class="lk-dots" id="lkDots"><i></i><i></i><i></i><i></i></div>' +
        '<div class="lk-msg" id="lkMsg"></div>' +
        '<div class="lk-pad" id="lkPad">' +
          ["1","2","3","4","5","6","7","8","9","del","0","ok"].map(function (k) {
            var label = k === "del" ? "⌫" : (k === "ok" ? "✓" : k);
            return '<button type="button" class="lk-key' + (k === "ok" ? " lk-ok" : "") +
                   (k === "del" ? " lk-del" : "") + '" data-k="' + k + '">' + label + "</button>";
          }).join("") +
        "</div>" +
        '<label class="lk-keep"><input type="checkbox" id="lkKeep"> 이 기기에서 7일간 기억하기</label>' +
        '<div class="lk-hint">힌트 · 대표님 생일 4자리 🎂</div>' +
      "</div>";
    document.body.appendChild(wrap);
    document.body.classList.add("locked");

    wrap.addEventListener("click", function (ev) {
      var b = ev.target.closest ? ev.target.closest(".lk-key") : null;
      if (!b) return;
      var k = b.getAttribute("data-k");
      if (k === "del") { pinBuf = pinBuf.slice(0, -1); paintDots(); return; }
      if (k === "ok") { tryPin(); return; }
      if (pinBuf.length >= 4) return;
      pinBuf += k;
      paintDots();
      if (pinBuf.length === 4) setTimeout(tryPin, 120);
    });
    document.addEventListener("keydown", function (ev) {
      if (!$("#" + LOCK_ID)) return;
      if (/^[0-9]$/.test(ev.key) && pinBuf.length < 4) { pinBuf += ev.key; paintDots(); if (pinBuf.length === 4) setTimeout(tryPin, 120); }
      else if (ev.key === "Backspace") { pinBuf = pinBuf.slice(0, -1); paintDots(); }
      else if (ev.key === "Enter") { tryPin(); }
    });
  }

  function paintDots() {
    var dots = document.querySelectorAll("#lkDots i");
    for (var i = 0; i < dots.length; i++) dots[i].classList.toggle("on", i < pinBuf.length);
  }
  function lockMsg(t, bad) {
    var m = $("#lkMsg");
    if (!m) return;
    m.textContent = t || "";
    m.classList.toggle("bad", !!bad);
  }
  function shake() {
    var c = document.querySelector("#" + LOCK_ID + " .lk-card");
    if (!c) return;
    c.classList.remove("lk-shake");
    void c.offsetWidth;
    c.classList.add("lk-shake");
  }

  function tryPin() {
    if (busy || pinBuf.length !== 4) { if (pinBuf.length !== 4) lockMsg("PIN 4자리를 모두 눌러 주세요", true); return; }
    busy = true;
    lockMsg("");
    var keep = !!(document.getElementById("lkKeep") && document.getElementById("lkKeep").checked);
    var salt = b64ToBuf(ENC.salt), iv = b64ToBuf(ENC.iv), ct = b64ToBuf(ENC.ct);
    deriveKey(pinBuf, salt, ENC.iter, keep).then(function (key) {
      return decryptWith(key, iv, ct).then(function (plain) {
        var data = JSON.parse(new TextDecoder().decode(plain));
        if (keep) {
          return crypto.subtle.exportKey("raw", key).then(function (raw) {
            var obj = { k: bufToB64(raw), exp: Date.now() + 7 * 86400000 };
            try { localStorage.setItem(KEEP_KEY, JSON.stringify(obj)); } catch (e) {}
            unlock(data);
          });
        }
        unlock(data);
      });
    }).catch(function () {
      busy = false;
      pinBuf = "";
      paintDots();
      shake();
      lockMsg("PIN 이 맞지 않아요 · 다시 눌러 주세요", true);
    });
  }

  /* 저장된 키로 자동 열기 (PIN 입력 생략) */
  function autoUnlock() {
    var raw = null, fromKeep = false;
    try {
      var s = sessionStorage.getItem(SESSION_KEY);
      if (s) raw = s;
    } catch (e) {}
    if (!raw) {
      try {
        var o = JSON.parse(localStorage.getItem(KEEP_KEY) || "null");
        if (o && o.k && o.exp > Date.now()) { raw = o.k; fromKeep = true; }
        else if (o) localStorage.removeItem(KEEP_KEY);
      } catch (e) {}
    }
    if (!raw) return Promise.reject(new Error("nokey"));
    return crypto.subtle.importKey("raw", b64ToBuf(raw), { name: "AES-GCM", length: 256 }, true, ["decrypt"])
      .then(function (key) {
        return decryptWith(key, b64ToBuf(ENC.iv), b64ToBuf(ENC.ct)).then(function (plain) {
          return JSON.parse(new TextDecoder().decode(plain));
        });
      })
      .then(function (data) {
        if (fromKeep) { try { sessionStorage.setItem(SESSION_KEY, raw); } catch (e) {} }
        unlock(data);
      });
  }

  function unlock(data) {
    window.__OFFICE_DATA = data;
    window.__OFFICE_META = data.meta || {};
    try { sessionStorage.setItem("yening_office_unlocked", "1"); } catch (e) {}
    var ls = $("#" + LOCK_ID);
    document.body.classList.remove("locked");
    if (ls) {
      ls.classList.add("lk-out");
      setTimeout(function () { if (ls && ls.parentNode) ls.parentNode.removeChild(ls); }, 420);
    }
    busy = false;
    var r = window.__PIN_READY_RESOLVE;
    if (r) { r(data); window.__PIN_READY_RESOLVE = null; }
    try {
      window.dispatchEvent(new CustomEvent("office:ready", { detail: window.__OFFICE_META || {} }));
    } catch (e) {}
    /* 앱이 잠금 화면 없이 먼저 그려졌다면 한 번 더 그리게 한다 */
    try { if (window.loadOffice) setTimeout(function () { window.loadOffice(false); }, 30); } catch (e) {}
  }

  function fatal(msg) {
    if (window.__PIN_READY_RESOLVE) {
      /* 앱이 영원히 기다리지 않도록 빈 응답으로 풀어 준다 */
      window.__PIN_READY_RESOLVE({ pay: {} });
      window.__PIN_READY_RESOLVE = null;
    }
    buildLock();
    var card = document.querySelector("#" + LOCK_ID + " .lk-card");
    if (card) card.innerHTML = '<div class="lk-logo">🥺</div><div class="lk-title">잠시 문제가 있어요</div>' +
      '<div class="lk-sub">' + msg + "</div><button class='lk-key lk-ok' style='width:auto;padding:10px 18px' onclick='location.reload()'>다시 시도</button>";
  }

  /* ---------------- /api/* → 암호화된 스냅샷 (+ 가계부는 폰 저장분 병합) ---------------- */
  var BLOCK_MSG = "📱 이 화면의 저장은 PC 버전에서 해 주세요 — 📒 가계부는 폰에서 바로 저장돼요";
  /* 🕵️ 염탐은 네이버를 긁어 오는 서버가 필요해서 폰에서는 돌릴 수 없다 — 요청 자체를 보내지 않고 안내만 한다 */
  var SPY_MOBILE_MSG = "📱 모바일은 매일 07:17 자동 측정 결과를 보여줘요 (즉시 측정은 PC에서 가능)";
  function jsonResponse(obj, status) {
    return new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }

  window.fetch = function (input, opt) {
    var url = (typeof input === "string") ? input : (input && input.url) || "";
    var path = url;
    try { path = new URL(url, location.href).pathname; } catch (e) {}
    var isApi = path.indexOf("/api/") === 0;
    if (!isApi) return realFetch ? realFetch(input, opt) : Promise.reject(new Error("no fetch"));

    var method = ((opt && opt.method) || "GET").toUpperCase();
    return window.__OFFICE_READY.then(function (data) {
      var pay = (data && data.pay) || {};
      if (method !== "GET") {
        /* 📒 예닝 가계부 — 모바일에서도 바로 저장(localStorage)하고 화면용 값을 그대로 돌려준다 */
        if (path === "/api/budget" && window.YB && typeof window.YB.apply === "function") {
          var body = {};
          try { body = JSON.parse((opt && opt.body) || "{}"); } catch (e) { body = {}; }
          var out;
          try { out = window.YB.apply(body, pay["/api/budget"] || {}); }
          catch (e) { out = { ok: false, error: "저장하지 못했어요: " + ((e && e.message) || e) }; }
          return jsonResponse(out);
        }
        /* 🕵️ 지금 다시 염탐 — 폰에는 수집 서버가 없으므로 안내만 띄우고 끝낸다 */
        if (path === "/api/spy/run") {
          try {
            if (typeof window.showSpyMobileNotice === "function") window.showSpyMobileNotice();
            else if (window.toast) window.toast(SPY_MOBILE_MSG);
          } catch (e) {}
          return jsonResponse({ ok: false, mobile: true, error: SPY_MOBILE_MSG,
                                state: { running: false, pct: 0, msg: "" } });
        }
        /* 나머지 저장·수정은 서버가 없으므로 정직하게 막는다 */
        try {
          if (path === "/api/campaigns" && window.renderCampaign) setTimeout(function () { try { window.renderCampaign(); } catch (e) {} }, 40);
          if (path === "/api/revenue" && window.renderRevenue) setTimeout(function () { try { window.renderRevenue(); } catch (e) {} }, 40);
          if (path === "/api/budget" && window.loadBudget) setTimeout(function () { try { window.loadBudget(); } catch (e) {} }, 40);
        } catch (e) {}
        return jsonResponse({ ok: false, error: BLOCK_MSG });
      }
      if (Object.prototype.hasOwnProperty.call(pay, path)) {
        if (path === "/api/budget" && window.YB && typeof window.YB.merge === "function") {
          /* PC 스냅샷 + 폰 저장분 병합 (중복 id 제거 · 지운 id 반영 · 합계 재계산) */
          try { return jsonResponse(window.YB.merge(pay[path] || {})); } catch (e) {}
        }
        return jsonResponse(pay[path]);
      }
      return jsonResponse({ ok: false, error: "이 화면은 모바일 버전에서 제공하지 않아요 (PC 버전 전용)" });
    });
  };

  /* ---------------- 시작 ---------------- */
  function boot() {
    buildLock();
    lockMsg("데이터를 불러오는 중…");
    realFetch("./data.enc.json", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (enc) {
        ENC = enc;
        if (!enc || !enc.ct || !enc.salt || !enc.iv) throw new Error("형식 오류");
        lockMsg("");
        return autoUnlock().catch(function () { /* PIN 입력 필요 */ });
      })
      .catch(function (e) {
        fatal("데이터 파일(data.enc.json)을 불러오지 못했어요 · " + (e && e.message ? e.message : ""));
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
