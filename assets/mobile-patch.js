/* ============================================================
   📱 예닝 오피스 모바일 웹 — 앱 스크립트 뒤에 붙는 보정 스크립트
   ============================================================ */
(function () {
  "use strict";
  var META = window.__OFFICE_META || {};

  function $(s) { return document.querySelector(s); }
  function toastSafe(t) {
    try { if (window.toast) window.toast(t); } catch (e) {}
  }

  function paintMeta(meta) {
    if (!meta || !meta.stamp) return;
    META = meta;
    var chip = $("#mobChip");
    if (!chip) {
      var side = $(".hero-side");
      if (side) {
        chip = document.createElement("span");
        chip.id = "mobChip";
        chip.className = "mobchip";
        chip.title = "PC에서 동기화한 스냅샷이에요";
        side.insertBefore(chip, side.firstChild);
      }
    }
    if (chip) chip.textContent = "📸 스냅샷 " + meta.stamp;
    var foot = $(".foot");
    if (foot) {
      foot.innerHTML = "📱 모바일 웹 버전 · 개인 데이터는 PIN(4자리)로 암호화되어 있어요 · 스냅샷 " +
        meta.stamp + " · 수정·저장은 PC 버전에서";
    }
  }

  try {
    paintMeta(META);

    /* 복호화가 끝나면 스냅샷 시각으로 다시 채운다 */
    if (window.__OFFICE_READY && window.__OFFICE_READY.then) {
      window.__OFFICE_READY.then(function (d) { paintMeta((d && d.meta) || {}); });
    }
    window.addEventListener("office:ready", function (ev) {
      paintMeta((ev && ev.detail) || {});
    });

    /* "현황 새로고침" 은 서버가 아니라 스냅샷 시각을 알려 준다 */
    var rf = $("#refresh");
    if (rf) {
      rf.onclick = function () {
        toastSafe("📸 " + (META.stamp || "") + " 스냅샷이에요 — 최신 값은 PC 버전에서 동기화해요");
      };
    }

    /* ⛏️ 키워드 채굴기는 PC 버전 전용 */
    window.pickSeeds = function () {
      toastSafe("⛏️ 키워드 채굴기는 PC 버전 전용이에요");
    };

    /* 👊 터치로 팀장 두 번 톡톡 = 때리기 */
    var lastTap = 0, lastEl = null;
    document.addEventListener("touchend", function (ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest(".desk[data-id]") : null;
      if (!el) return;
      var now = Date.now();
      if (lastEl === el && now - lastTap < 420) {
        lastEl = null; lastTap = 0;
        try { if (window.hitLeader) window.hitLeader(el); } catch (e) {}
      } else {
        lastEl = el; lastTap = now;
      }
    }, { passive: true });

    /* 무대를 길게 눌러도 브라우저 메뉴가 뜨지 않게 */
    document.addEventListener("contextmenu", function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest("#stage, .tab, .btn")) ev.preventDefault();
    });
  } catch (e) {
    if (window.console) console.warn("[mobile-patch]", e);
  }
})();
