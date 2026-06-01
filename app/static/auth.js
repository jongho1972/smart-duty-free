/* 비밀번호 게이트 (신라면세점 서브페이지와 동일 비번 0708)
 * 오버레이 UX는 형제 프로젝트와 통일. 검증은 서버(/api/verify)에서 수행해
 * 인증 쿠키를 설정하므로 /api/compare 도 함께 보호된다. */
(function () {
  var AUTH_KEY = "sdf_auth_ok";

  // 탭 닫고 다시 열기/브라우저 재시작 시 인증 무효화
  try {
    var navEntry = (performance.getEntriesByType &&
      performance.getEntriesByType("navigation")[0]) || null;
    var navType = navEntry ? navEntry.type : "";
    var sameOriginRef = document.referrer && document.referrer.indexOf(location.origin) === 0;
    if (navType === "back_forward" && !sameOriginRef) {
      sessionStorage.removeItem(AUTH_KEY);
    }
  } catch (e) {}

  var gateStyle = document.getElementById("auth-gate");

  function alreadyAuthed() {
    try { return sessionStorage.getItem(AUTH_KEY) === "1"; } catch (e) { return false; }
  }

  if (alreadyAuthed()) {
    if (gateStyle) gateStyle.remove();
    return;
  }
  if (gateStyle) {
    gateStyle.textContent = "body > *:not(#pw-overlay){display:none!important}";
  }

  function removeGate() {
    try { sessionStorage.setItem(AUTH_KEY, "1"); } catch (e) {}
    var ov = document.getElementById("pw-overlay");
    if (ov) ov.remove();
    if (gateStyle) gateStyle.remove();
    var st = document.getElementById("pw-style");
    if (st) st.remove();
  }

  // /api/compare 가 401이면 다시 게이트를 띄우기 위해 노출
  window.__showAuthGate = mountGate;

  function mountGate() {
    if (document.getElementById("pw-overlay")) return;
    if (gateStyle) gateStyle.textContent = "body > *:not(#pw-overlay){display:none!important}";
    var style = document.createElement("style");
    style.id = "pw-style";
    style.textContent =
      '#pw-overlay{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#8C0023,#5e0017);font-family:"Noto Sans KR",sans-serif}' +
      "#pw-box{text-align:center;padding:46px 40px;background:#fff;border-radius:18px;box-shadow:0 24px 60px -20px rgba(0,0,0,.5)}" +
      '#pw-box h2{margin:0 0 6px;font-size:19px;color:#1a1416;font-family:"Outfit","Noto Sans KR",sans-serif;font-weight:800}' +
      "#pw-box p{color:#8a8079;margin:0 0 16px;font-size:13.5px}" +
      "#pw-box input{padding:12px 16px;font-size:18px;border:1.5px solid #e7e1dd;border-radius:10px;text-align:center;width:150px;letter-spacing:8px}" +
      "#pw-box input:focus{outline:none;border-color:#B8922A;box-shadow:0 0 0 3px rgba(184,146,42,.18)}" +
      '#pw-box button{margin-left:8px;padding:12px 22px;font-size:14px;background:#8C0023;color:#fff;border:none;border-radius:10px;cursor:pointer;font-weight:700;font-family:"Outfit","Noto Sans KR",sans-serif}' +
      "#pw-box button:hover{background:#a80030}" +
      "#pw-err{color:#c00;font-size:13px;margin-top:12px;display:none}";
    document.head.appendChild(style);

    var overlay = document.createElement("div");
    overlay.id = "pw-overlay";
    overlay.innerHTML =
      '<div id="pw-box">' +
      "<h2>접근 제한</h2>" +
      "<p>비밀번호를 입력하세요</p>" +
      '<div><input id="pw-input" type="password" maxlength="10" autocomplete="off" autofocus>' +
      '<button id="pw-btn" type="button">확인</button></div>' +
      '<div id="pw-err">비밀번호가 올바르지 않습니다</div>' +
      "</div>";
    document.body.appendChild(overlay);

    var input = overlay.querySelector("#pw-input");
    var btn = overlay.querySelector("#pw-btn");
    var err = overlay.querySelector("#pw-err");

    async function unlock() {
      err.style.display = "none";
      btn.disabled = true;
      try {
        var res = await fetch("/api/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: input.value }),
        });
        if (res.ok) {
          removeGate();
          return;
        }
      } catch (e) {}
      btn.disabled = false;
      err.style.display = "block";
      input.value = "";
      input.focus();
    }

    btn.addEventListener("click", unlock);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") unlock();
    });
    input.focus();
  }

  if (document.body) mountGate();
  else document.addEventListener("DOMContentLoaded", mountGate);
})();
