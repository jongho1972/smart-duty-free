const results = document.getElementById("results");
const hint = document.getElementById("hint");
const SHOP_ORDER = ["신라", "롯데", "신세계"];

// ── 조회 몰 선택 (KR/CN/EN/JP) ─────────────────────────────────────────────
let currentMall = "kr";
const MALL_INFO = {
  cn: "중문몰 기준으로 조회합니다 — 상품명은 중문으로 표시됩니다",
  en: "영문몰 기준으로 조회합니다 — 상품명은 영문으로 표시됩니다",
  jp: "일문몰 기준으로 조회합니다 — 상품명은 일문으로 표시되며, 신세계는 일문몰을 미운영합니다",
};
// 토글·안내문 DOM 노드 참조 — 결과 렌더 시 결과 툴바로 이동해 재사용(리스너 유지)
const mallToggleEl = document.querySelector(".mall-toggle");
const mallNoteEl = document.getElementById("mall-note");

// 몰 상태(currentMall + 토글 버튼 + 안내문) 갱신 — 재조회는 호출부에서 별도 처리
function applyMallState(mall) {
  currentMall = mall;
  document.querySelectorAll(".mall-btn").forEach((b) => {
    const on = b.dataset.mall === mall;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on);
  });
  if (mallNoteEl) {
    mallNoteEl.textContent = MALL_INFO[mall] || "";
    mallNoteEl.hidden = mall === "kr";
  }
}

(function initMallToggle() {
  document.querySelectorAll(".mall-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.mall === currentMall) return;
      // 조회 진행 중 몰을 바꾸면 한 표에 몰이 섞이므로 전환을 막는다
      if (document.body.classList.contains("loading")) return;
      applyMallState(btn.dataset.mall);
      // 결과가 이미 있으면: 캐시된 몰이면 즉시 복원, 아니면 해당 몰로 조회
      if (lastSkus.length) {
        const snap = mallCache[mallCacheKey(currentMall, lastSkus)];
        if (snap) restoreMallCache(snap);
        else runBatch(lastSkus.map((sku) => ({ sku })));
      }
    });
  });
})();

// ── 면세점 계정 관리 (sessionStorage) ──────────────────────────────────────
function loadCreds() {
  return {
    lotteId: sessionStorage.getItem("df_lotte_id") || "",
    lottePw: sessionStorage.getItem("df_lotte_pw") || "",
    ssgId:   sessionStorage.getItem("df_ssg_id")   || "",
    ssgPw:   sessionStorage.getItem("df_ssg_pw")   || "",
  };
}

// 로그인 결과(성공/실패)를 sessionStorage에 저장해두면, 같은 탭이 재사용돼
// 페이지가 다시 로드돼도(가격비교 탭 재사용 등) 재조회 없이 배지를 복원할 수 있다.
function saveLoginResult(lotteOk, ssgOk) {
  sessionStorage.setItem("df_login_result", JSON.stringify({ lotteOk, ssgOk }));
}
function loadLoginResult() {
  try {
    return JSON.parse(sessionStorage.getItem("df_login_result") || "null");
  } catch {
    return null;
  }
}

// 로그인 결과를 상태 문구(모달)·칩(상단)에 반영. 시도하지 않은 몰을 "실패"로
// 표기하지 않도록 성공한 몰만 나열한다. result가 없으면(첫 방문) 둘 다 숨긴다.
function renderLoginResult(loginStatus, credBadge, result) {
  if (!result) {
    if (loginStatus) loginStatus.hidden = true;
    if (credBadge) credBadge.hidden = true;
    return false;
  }
  const { lotteOk, ssgOk } = result;
  const okNames = [lotteOk && "L.POINT", ssgOk && "신세계"].filter(Boolean);
  const anyOk = okNames.length > 0;
  if (loginStatus) {
    loginStatus.textContent = anyOk
      ? `${okNames.join("·")} 로그인됨`
      : "로그인 실패 — 아이디·비밀번호를 확인해 주세요.";
    loginStatus.className = anyOk ? "cred-login-status ok" : "cred-login-status fail";
    loginStatus.hidden = false;
  }
  // 상단 칩: 모달이 닫혀도 어느 면세점에 로그인됐는지 보이게 표시
  if (credBadge) {
    credBadge.textContent = anyOk ? `${okNames.join("·")} 로그인됨` : "로그인 실패";
    credBadge.className = anyOk ? "cred-badge saved" : "cred-badge failed";
    credBadge.hidden = false;
  }
  return anyOk;
}

// 로그인 모달 열기/닫기 — 결과 표의 "🔒 로그인 시" 클릭 시 호출되도록 상위 스코프에 노출
let openLoginModal = () => {};
let closeLoginModal = () => {};

(function initCreds() {
  const c = loadCreds();
  const modal = document.getElementById("login-modal");
  const chip = document.getElementById("login-chip");
  const closeBtn = document.getElementById("login-close-btn");
  const desc = document.getElementById("login-modal-desc");
  const li = document.getElementById("lotte-id");
  const lp = document.getElementById("lotte-pw");
  const si = document.getElementById("ssg-id");
  const sp = document.getElementById("ssg-pw");
  const lotteRow = document.querySelector('.cred-row[data-site="lotte"]');
  const ssgRow = document.querySelector('.cred-row[data-site="ssg"]');
  const reloginBtn = document.getElementById("cred-relogin-btn");
  const refetchBtn = document.getElementById("cred-refetch-btn");
  const loginStatus = document.getElementById("cred-login-status");
  if (li) li.value = c.lotteId;
  if (lp) lp.value = c.lottePw;
  if (si) si.value = c.ssgId;
  if (sp) sp.value = c.ssgPw;

  // 이전 로그인 결과가 있으면 상단 칩에 복원(재조회 없이)
  renderLoginResult(loginStatus, chip, loadLoginResult());

  // sites: "all" | "lotte" | "ssg" | ["lotte","ssg"] — 표시할 몰 목록
  openLoginModal = (sites) => {
    let list;
    if (sites === "all" || sites == null) list = ["lotte", "ssg"];
    else if (typeof sites === "string") list = [sites];
    else list = sites.length ? sites : ["lotte", "ssg"];
    const showLotte = list.includes("lotte");
    const showSsg = list.includes("ssg");
    if (lotteRow) lotteRow.hidden = !showLotte;
    if (ssgRow) ssgRow.hidden = !showSsg;
    if (desc) {
      desc.textContent =
        showLotte && showSsg ? "로그인이 필요한 면세점을 로그인한 뒤 ‘다시 조회’를 눌러 주세요."
        : showLotte ? "롯데 L.POINT 로그인 후 ‘다시 조회’를 눌러 주세요."
        : "신세계 회원 로그인 후 ‘다시 조회’를 눌러 주세요.";
    }
    if (loginStatus) loginStatus.hidden = true;
    // 이미 로그인돼 있고 가려진 행이 남아 있으면 재로그인 없이 바로 "다시 조회" 노출
    const prev = loadLoginResult();
    const alreadyLoggedIn = !!(prev && (prev.lotteOk || prev.ssgOk));
    if (refetchBtn) refetchBtn.hidden = !(alreadyLoggedIn && gatedRows.length);
    modal.hidden = false;
    const firstInput = showLotte ? li : si;
    setTimeout(() => firstInput?.focus(), 30);
  };
  closeLoginModal = () => { modal.hidden = true; };

  closeBtn?.addEventListener("click", closeLoginModal);
  modal?.addEventListener("click", (e) => { if (e.target === modal) closeLoginModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal && !modal.hidden) closeLoginModal();
  });

  // 결과 표의 "🔒 로그인 시" 클릭 → 로그인이 필요한 면세점을 모두 모달에 표시
  document.addEventListener("click", (e) => {
    const hint = e.target.closest && e.target.closest(".login-hint.clickable");
    if (!hint) return;
    const sites = gatedShops.size ? [...gatedShops] : [hint.dataset.loginSite || "lotte"];
    openLoginModal(sites);
  });

  reloginBtn?.addEventListener("click", async () => {
    // 현재 입력값을 sessionStorage에 먼저 저장
    sessionStorage.setItem("df_lotte_id", (li?.value || "").trim());
    sessionStorage.setItem("df_lotte_pw", lp?.value || "");
    sessionStorage.setItem("df_ssg_id",   (si?.value || "").trim());
    sessionStorage.setItem("df_ssg_pw",   sp?.value || "");

    reloginBtn.disabled = true;
    reloginBtn.textContent = "로그인 중…";
    if (loginStatus) loginStatus.hidden = true;
    if (refetchBtn) refetchBtn.hidden = true;   // 로그인 재시도 시 이전 재조회 버튼 초기화
    try {
      const cc = loadCreds();
      const hdrs = {};
      if (cc.lotteId) hdrs["X-Lotte-Id"] = cc.lotteId;
      if (cc.lottePw) hdrs["X-Lotte-Pw"] = cc.lottePw;
      if (cc.ssgId)   hdrs["X-Ssg-Id"]   = cc.ssgId;
      if (cc.ssgPw)   hdrs["X-Ssg-Pw"]   = cc.ssgPw;
      const res = await fetch("/api/login-reset", { method: "POST", headers: hdrs });
      const data = await res.json();
      const lotteOk = !!data.lotte_login;
      const ssgOk = !!data.ssg_login;
      saveLoginResult(lotteOk, ssgOk);
      const anyOk = renderLoginResult(loginStatus, chip, { lotteOk, ssgOk });
      // 성공 & 재조회할 행이 있으면 모달을 닫지 않고 "다시 조회" 버튼을 노출
      if (anyOk && refetchBtn && gatedRows.length) {
        refetchBtn.hidden = false;
        setTimeout(() => refetchBtn.focus(), 30);
      }
    } catch {
      if (loginStatus) {
        loginStatus.textContent = "서버 연결 실패 — 잠시 후 다시 시도해 주세요.";
        loginStatus.className = "cred-login-status fail";
        loginStatus.hidden = false;
      }
    } finally {
      reloginBtn.disabled = false;
      reloginBtn.textContent = "로그인";
    }
  });

  // "다시 조회" — 로그인 성공 후 가려졌던 행만 재조회하고 모달을 닫는다
  refetchBtn?.addEventListener("click", async () => {
    refetchBtn.disabled = true;
    refetchBtn.textContent = "재조회 중…";
    try {
      await refreshGatedRows();
    } finally {
      refetchBtn.disabled = false;
      refetchBtn.textContent = "다시 조회";
      refetchBtn.hidden = true;
      closeLoginModal();
    }
  });
})();

const batchForm = document.getElementById("batch-form");
const batchInput = document.getElementById("batch-input");
const batchBtn = document.getElementById("batch-btn");
const clearBtn = document.getElementById("clear-btn");
const MAX_BATCH_ROWS = 50;

clearBtn.addEventListener("click", () => {
  batchInput.value = "";
  batchInput.focus();
});

// ?skus=sku1,sku2,...&mall=cn 파라미터로 진입 시 몰을 디폴트로 세팅하고
// 입력만 채운다(조회는 사용자가 직접 실행 — SKU 조회 사이트에서 넘어온 경우 등)
(function () {
  const q = new URLSearchParams(location.search);
  const mallParam = (q.get("mall") || "").toLowerCase();
  if (Object.keys(MALL_INFO).includes(mallParam)) applyMallState(mallParam);
  const skusParam = q.get("skus");
  if (!skusParam) return;
  const skus = skusParam.split(",").map((s) => s.trim()).filter(Boolean);
  if (!skus.length) return;
  batchInput.value = skus.join("\n");
})();

// 엑셀(.xlsx) 다운로드용 누적 데이터 (면세점별 할인률+링크를 구조화해 보관)
let exportRows = [];
// 직전 조회 SKU 목록 — 몰 토글 시 자동 재조회에 사용
let lastSkus = [];
// 할인율이 로그인에 가려진 행들 [{sku, num}] — 로그인 성공 시 이 행만 재조회
let gatedRows = [];
// 현재 결과에서 로그인이 필요한 몰들("lotte"/"ssg") — "🔒 로그인 시" 클릭 시 모두 모달에 표시
let gatedShops = new Set();
// 조회 세대 토큰 — 재조회(refreshGatedRows) 도중 새 배치가 시작되면 옛 재조회를 중단
let batchGeneration = 0;
// 결과표 정렬 상태 — {key, type, dir}. key=null이면 원래(조회) 순서
let sortState = { key: null, type: null, dir: null };
// 정렬 키별 자료형(모바일 셀렉트용 — 데스크톱 헤더는 data-type 속성 사용)
const SORT_KEY_TYPES = {
  num: "num", price: "num", shilla: "num", lotte: "num", ssg: "num",
  sku: "text", brand: "text", branden: "text", category: "text", name: "text", ref: "text",
};

// 몰별 결과 캐시 — 이미 조회한 몰로 토글하면 재조회 없이 즉시 복원(KR↔CN↔KR 반복 재조회 방지).
// key = `${mall}|${skus.join(',')}`. 새 조회(폼 제출)·로그인 후 재조회 시 무효화.
const mallCache = {};
function mallCacheKey(mall, skus) { return mall + "|" + skus.join(","); }
function clearMallCache() { for (const k of Object.keys(mallCache)) delete mallCache[k]; }

// 일괄 입력 파싱: 한 줄 = SKU 번호 하나
function parseBatch(raw) {
  return (raw || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((sku) => ({ sku }));
}

batchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  let rows = parseBatch(batchInput.value);
  if (rows.length === 0) {
    flashHint("조회할 SKU 번호를 한 줄에 하나씩 입력해 주세요.");
    return;
  }
  let truncated = false;
  if (rows.length > MAX_BATCH_ROWS) {
    rows = rows.slice(0, MAX_BATCH_ROWS);
    truncated = true;
  }
  clearMallCache();   // 새 조회 → 이전 SKU 세트의 몰 캐시 폐기
  sortState = { key: null, type: null, dir: null };   // 새 SKU 세트 → 정렬 초기화(몰 토글에는 유지)
  await runBatch(rows);
  if (truncated) {
    flashHint(`한 번에 최대 ${MAX_BATCH_ROWS}개까지만 비교합니다. 나머지는 다시 나눠 조회해 주세요.`);
  }
});

// 실제 일괄 조회 실행 — 폼 제출과 몰 토글 자동 재조회가 공유
async function runBatch(rows) {
  lastSkus = rows.map((r) => r.sku);
  batchGeneration++;   // 이전 배치의 재조회가 이 배치의 행을 건드리지 않도록 세대 증가
  setBatchLoading(true);
  results.hidden = false;
  exportRows = [];
  gatedRows = [];
  gatedShops = new Set();
  results.innerHTML = `
    <div class="login-cta" id="login-cta" hidden>
      <span class="login-cta-msg">🔒 <b>롯데·신세계 할인율</b>은 회원 로그인 후 표시됩니다.</span>
      <button type="button" id="login-cta-btn">로그인하고 전체 비교</button>
    </div>
    <div class="results-toolbar">
      <label class="sort-mobile">정렬
        <select id="sort-select" aria-label="결과 정렬">
          <option value="num:asc">기본 순서</option>
          <option value="price:desc">정가 높은순</option>
          <option value="price:asc">정가 낮은순</option>
          <option value="shilla:desc">신라 할인율 높은순</option>
          <option value="shilla:asc">신라 할인율 낮은순</option>
          <option value="lotte:desc">롯데 할인율 높은순</option>
          <option value="ssg:desc">신세계 할인율 높은순</option>
          <option value="brand:asc">국문 브랜드명순</option>
          <option value="name:asc">상품명순</option>
        </select>
      </label>
      <button type="button" id="excel-btn" disabled>엑셀 다운로드</button>
    </div>
    <div class="table-wrap">
      <table class="compare-table">
        <thead>
          <tr>
            <th class="col-num sortable" data-key="num" data-type="num" role="button" tabindex="0" aria-sort="none" title="클릭해 정렬">#</th>
            <th class="sortable" data-key="brand" data-type="text" role="button" tabindex="0" aria-sort="none" title="클릭해 정렬">국문 브랜드명</th>
            <th class="sortable" data-key="branden" data-type="text" role="button" tabindex="0" aria-sort="none" title="클릭해 정렬">영문 브랜드명</th>
            <th class="sortable" data-key="category" data-type="text" role="button" tabindex="0" aria-sort="none" title="클릭해 정렬">상품유형</th>
            <th class="col-name sortable" data-key="name" data-type="text" role="button" tabindex="0" aria-sort="none" title="클릭해 정렬">상품명</th>
            <th class="col-sku sortable" data-key="sku" data-type="text" role="button" tabindex="0" aria-sort="none" title="클릭해 정렬">SKU</th>
            <th class="sortable" data-key="ref" data-type="text" role="button" tabindex="0" aria-sort="none" title="클릭해 정렬">REF</th>
            <th class="col-rate sortable" data-key="price" data-type="num" role="button" tabindex="0" aria-sort="none" title="클릭해 정렬">정가(USD)</th>
            <th class="col-rate sortable" data-key="shilla" data-type="num" role="button" tabindex="0" aria-sort="none" title="클릭해 정렬">신라</th>
            <th class="col-rate sortable" data-key="lotte" data-type="num" role="button" tabindex="0" aria-sort="none" title="클릭해 정렬">롯데</th>
            <th class="col-rate sortable" data-key="ssg" data-type="num" role="button" tabindex="0" aria-sort="none" title="클릭해 정렬">신세계</th>
            <th>링크</th>
          </tr>
        </thead>
        <tbody id="compare-body"></tbody>
      </table>
    </div>
    `;
  const tbody = results.querySelector("#compare-body");
  const excelBtn = results.querySelector("#excel-btn");
  excelBtn.addEventListener("click", downloadExcel);
  // 몰 토글을 툴바의 엑셀 다운로드 버튼 왼쪽으로 이동해 노출
  const toolbar = results.querySelector(".results-toolbar");
  toolbar.insertBefore(mallToggleEl, excelBtn);
  mallToggleEl.hidden = false;
  toolbar.after(mallNoteEl);
  mallNoteEl.hidden = currentMall === "kr";
  refreshSortUI();   // 새로 그린 헤더·셀렉트를 (유지 중인) 정렬 상태에 맞춰 동기화
  const prog = document.getElementById("batch-progress");
  prog.hidden = false;
  // 로그인 유도 배너: 아직 로그인 안 한 게이팅 몰만 대상(로그인됨 상태와 모순 방지)
  const ctaBtn = results.querySelector("#login-cta-btn");
  ctaBtn?.addEventListener("click", () => {
    const pend = pendingLoginShops();
    openLoginModal(pend.length ? pend : "all");
  });
  // 결과가 입력폼·안내문 아래 멀리 렌더되므로 조회 시작과 함께 결과로 스크롤
  results.scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      prog.textContent = `조회 중… (${i + 1}/${rows.length}) SKU: ${row.sku}`;
      let tr, data = {};
      try {
        const params = new URLSearchParams({ sku: row.sku, mall: currentMall });
        const creds = loadCreds();
        const credHeaders = {};
        if (creds.lotteId) credHeaders["X-Lotte-Id"] = creds.lotteId;
        if (creds.lottePw) credHeaders["X-Lotte-Pw"] = creds.lottePw;
        if (creds.ssgId)   credHeaders["X-Ssg-Id"]   = creds.ssgId;
        if (creds.ssgPw)   credHeaders["X-Ssg-Pw"]   = creds.ssgPw;
        const res = await fetch(`/api/compare-by-sku?${params.toString()}`, { headers: credHeaders });
        data = await res.json();
        tr = buildProductRow(data, row, i + 1);
      } catch (err) {
        data = {};
        tr = buildErrorRow(row, null, i + 1);
      }
      tbody.insertAdjacentHTML("beforeend", tr);
      if (sortState.key) applySort();   // 정렬 활성 중이면 새 행도 제자리에 배치
      exportRows.push(extractExportRow(data, row));
      // 롯데·신세계 할인율이 로그인에 가려진 행·몰 기록 → 로그인 성공 시 이 행만 재조회
      const gs = gatedShopsOf(data);
      if (gs.length) {
        gatedRows.push({ sku: row.sku, num: i + 1 });
        gs.forEach((s) => gatedShops.add(s));
      }
    }
  } finally {
    prog.hidden = true;
    prog.textContent = "";
    excelBtn.disabled = exportRows.length === 0;
    setBatchLoading(false);
    updateLoginCta();
    // 이 몰 결과를 캐시 → 나중에 같은 SKU로 이 몰에 토글하면 재조회 없이 복원
    mallCache[mallCacheKey(currentMall, lastSkus)] = {
      html: tbody.innerHTML,
      exportRows: exportRows.slice(),
      gatedRows: gatedRows.slice(),
      gatedShops: [...gatedShops],
    };
  }
}

// 캐시된 몰 결과를 재조회 없이 즉시 복원(토글 전환용)
function restoreMallCache(snap) {
  batchGeneration++;   // 진행 중이던 옛 재조회가 이 화면을 건드리지 못하게 세대 증가
  results.hidden = false;
  exportRows = snap.exportRows.slice();
  gatedRows = snap.gatedRows.slice();
  gatedShops = new Set(snap.gatedShops);
  const tbody = results.querySelector("#compare-body");
  if (tbody) tbody.innerHTML = snap.html;
  const excelBtn = results.querySelector("#excel-btn");
  if (excelBtn) excelBtn.disabled = exportRows.length === 0;
  mallNoteEl.hidden = currentMall === "kr";
  if (sortState.key) applySort();   // 유지 중인 정렬을 복원된 행에도 적용
  refreshSortUI();                  // 화살표·셀렉트를 정렬 상태에 동기화
  updateLoginCta();
}

// 가려진 몰(gatedShops) 중 아직 로그인 성공하지 않은 몰만 반환 — 배너·모달 대상
function pendingLoginShops() {
  const li = loadLoginResult() || {};
  return [...gatedShops].filter(
    (s) => (s === "lotte" && !li.lotteOk) || (s === "ssg" && !li.ssgOk)
  );
}

// 로그인 유도 배너 갱신: 아직 로그인 안 한 게이팅 몰만 대상(없으면 숨김 → 로그인됨 상태와 모순 방지)
function updateLoginCta() {
  const cta = results.querySelector("#login-cta");
  if (!cta) return;
  const pend = pendingLoginShops();
  if (!pend.length) { cta.hidden = true; return; }
  const names = pend.map((s) => (s === "lotte" ? "롯데" : "신세계")).join("·");
  const msg = cta.querySelector(".login-cta-msg");
  if (msg) msg.innerHTML = `🔒 <b>${names} 할인율</b>은 회원 로그인 후 표시됩니다.`;
  cta.hidden = false;
}

function setBatchLoading(on) {
  document.body.classList.toggle("loading", on);
  batchBtn.disabled = on;
}

// 할인율이 로그인에 가려진 몰인가 (found·login_required·할인율 없음)
function isGated(r) {
  return !!(r && r.found && r.login_required && r.discount_rate == null);
}
// 이 행에서 로그인이 필요한 몰 목록(["lotte","ssg"] 중)
function gatedShopsOf(data) {
  const shops = (data && data.shops) || {};
  const out = [];
  if (isGated(shops["롯데"])) out.push("lotte");
  if (isGated(shops["신세계"])) out.push("ssg");
  return out;
}

// 로그인 성공 후: 할인율이 가려졌던 행만 재조회해 제자리에서 갱신(전체 재조회 회피)
async function refreshGatedRows() {
  if (!gatedRows.length) return;
  const gen = batchGeneration;   // 이 세대의 행만 갱신 — 새 배치가 시작되면 중단
  const creds = loadCreds();
  const credHeaders = {};
  if (creds.lotteId) credHeaders["X-Lotte-Id"] = creds.lotteId;
  if (creds.lottePw) credHeaders["X-Lotte-Pw"] = creds.lottePw;
  if (creds.ssgId)   credHeaders["X-Ssg-Id"]   = creds.ssgId;
  if (creds.ssgPw)   credHeaders["X-Ssg-Pw"]   = creds.ssgPw;
  const still = [];
  const newShops = new Set();
  for (const g of gatedRows) {
    if (gen !== batchGeneration) return;   // 새 배치가 시작됨 → 옛 재조회 중단(행 오염 방지)
    try {
      const params = new URLSearchParams({ sku: g.sku, mall: currentMall });
      const res = await fetch(`/api/compare-by-sku?${params.toString()}`, { headers: credHeaders });
      if (gen !== batchGeneration) return;
      const data = await res.json();
      const html = buildProductRow(data, { sku: g.sku }, g.num);
      const oldTr = document.getElementById(`cmp-row-${g.num}`);
      if (oldTr) oldTr.outerHTML = html;
      exportRows[g.num - 1] = extractExportRow(data, { sku: g.sku });
      const gs = gatedShopsOf(data);
      if (gs.length) {
        still.push(g); // 여전히 가려짐(로그인 실패 등) → 다음 로그인 때 재시도
        gs.forEach((s) => newShops.add(s));
      }
    } catch {
      still.push(g);
    }
  }
  if (gen === batchGeneration) {
    gatedRows = still;
    gatedShops = newShops;
    if (sortState.key) applySort();   // 할인율이 채워진 행을 정렬 위치로 재배치
    updateLoginCta();   // 재조회로 로그인 풀린 몰이 있으면 배너 숨김/갱신
    clearMallCache();   // 로그인으로 결과가 바뀜 → 몰 캐시 폐기(토글 시 최신 재조회)
    // 현재 몰의 갱신된 결과는 다시 캐시해 둔다(같은 몰 재토글 시 재조회 회피)
    const tbody = results.querySelector("#compare-body");
    if (tbody) {
      mallCache[mallCacheKey(currentMall, lastSkus)] = {
        html: tbody.innerHTML,
        exportRows: exportRows.slice(),
        gatedRows: gatedRows.slice(),
        gatedShops: [...gatedShops],
      };
    }
  }
}

function flashHint(msg) {
  hint.textContent = msg;
  hint.style.color = "#99202a";
  setTimeout(() => (hint.style.color = ""), 2600);
}

// ── 결과표 컬럼 정렬 ────────────────────────────────────────────────────────
// 현재 sortState 기준으로 tbody의 행을 재배치. 빈 값(미취급·로그인 시 등)은
// 방향과 무관하게 항상 하단으로 모은다(정직한 '없음'을 위/아래로 흩뿌리지 않음).
function applySort() {
  const tbody = results.querySelector("#compare-body");
  if (!tbody || !sortState.key) return;
  const { key, type, dir } = sortState;
  const rows = [...tbody.querySelectorAll("tr")];
  rows.sort((a, b) => {
    const va = a.getAttribute("data-" + key);
    const vb = b.getAttribute("data-" + key);
    const aEmpty = va == null || va === "";
    const bEmpty = vb == null || vb === "";
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;    // 빈 값은 항상 아래로
    if (bEmpty) return -1;
    let cmp;
    if (type === "num") cmp = Number(va) - Number(vb);
    else cmp = String(va).localeCompare(String(vb), "ko");
    return dir === "desc" ? -cmp : cmp;
  });
  rows.forEach((r) => tbody.appendChild(r));
}

// 헤더의 정렬 방향 표시(화살표·aria-sort) 갱신
function updateSortIndicators() {
  results.querySelectorAll("thead th.sortable").forEach((th) => {
    th.classList.remove("sorted-asc", "sorted-desc");
    if (th.dataset.key === sortState.key) {
      const desc = sortState.dir === "desc";
      th.classList.add(desc ? "sorted-desc" : "sorted-asc");
      th.setAttribute("aria-sort", desc ? "descending" : "ascending");
    } else {
      th.setAttribute("aria-sort", "none");
    }
  });
}

// 모바일 정렬 셀렉트를 현재 정렬 상태에 맞춰 동기화(해당 옵션이 있을 때만)
function syncSortSelect() {
  const sel = results.querySelector("#sort-select");
  if (!sel) return;
  const want = sortState.key ? `${sortState.key}:${sortState.dir}` : "num:asc";
  if ([...sel.options].some((o) => o.value === want)) sel.value = want;
}

// 헤더 화살표 + 모바일 셀렉트를 한 번에 정렬 상태와 일치시킨다(모든 렌더 경로 공용)
function refreshSortUI() {
  updateSortIndicators();
  syncSortSelect();
}

// 정렬 가능한 헤더 클릭 → asc ↔ desc 토글(다른 컬럼이면 asc부터). '#'로 원래 순서 복원.
results.addEventListener("click", (e) => {
  const th = e.target.closest && e.target.closest("thead th.sortable");
  if (!th || !results.contains(th)) return;
  const key = th.dataset.key;
  const type = th.dataset.type || "text";
  const dir = sortState.key === key && sortState.dir === "asc" ? "desc" : "asc";
  sortState = { key, type, dir };
  applySort();
  refreshSortUI();
});

// 헤더 키보드 정렬(Enter/Space) — 접근성
results.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const th = e.target.closest && e.target.closest("thead th.sortable");
  if (!th || !results.contains(th)) return;
  e.preventDefault();
  th.click();
});

// 모바일 정렬 셀렉트(헤더가 숨겨지는 좁은 화면용) — value="key:dir"
results.addEventListener("change", (e) => {
  const sel = e.target.closest && e.target.closest("#sort-select");
  if (!sel) return;
  const [key, dir] = sel.value.split(":");
  sortState = { key, type: SORT_KEY_TYPES[key] || "text", dir: dir || "asc" };
  applySort();
  refreshSortUI();
});

// 조회 결과 1건 → sku_lookup 포맷 행 + 경쟁사 할인률 컬럼
function buildProductRow(data, row, num) {
  if (data.error) return buildErrorRow(row, data.error, num);

  const shops = data.shops || {};
  const errors = data.errors || {};
  const query = data.query || {};
  // 신라 열세 강조 기준: 신라 할인율(있을 때만). 경쟁사가 이보다 높으면 그 셀을 강조.
  const shillaRate = shops["신라"] && shops["신라"].found ? shops["신라"].discount_rate : null;

  const rateCell = (shop) => {
    const r = shops[shop];
    if (r && r.unsupported) {
      return `<td data-label="${shop} 할인률" class="col-rate na">미운영</td>`;
    }
    if (!r || !r.found) {
      // 실제 예외(조회 오류)와 미취급/판매종료(상품 못 찾음)를 구분해 표기
      return errors[shop]
        ? `<td data-label="${shop} 할인률" class="col-rate na err" title="일시적인 조회 오류입니다. 잠시 후 다시 시도해 주세요.">조회 오류</td>`
        : `<td data-label="${shop} 할인률" class="col-rate na" title="${shop}에서 이 상품을 찾지 못했습니다 (미취급이거나 판매 종료).">미취급</td>`;
    }
    // 할인율이 로그인에 막혔고 자격증명이 없어 정가만 온 경우 → 클릭 시 해당 몰 로그인 모달
    if (r.discount_rate == null && r.login_required) {
      const site = shop === "신세계" ? "ssg" : "lotte";
      return `<td data-label="${shop} 할인률" class="col-rate na"><span class="login-hint clickable" data-login-site="${site}" title="클릭해 로그인하면 할인율이 표시됩니다">🔒 로그인 시</span></td>`;
    }
    const rate = r.discount_rate != null ? r.discount_rate + "%" : "—";
    const soldout = r.soldout ? ` <span class="soldout-tag" title="해당 면세점 품절">품절</span>` : "";
    // 경쟁사(롯데·신세계)가 신라보다 할인율이 높은 셀 = 신라 열세 → 빨강 강조
    const behind = shop !== "신라" && shillaRate != null
      && r.discount_rate != null && r.discount_rate > shillaRate;
    const cls = behind ? "col-rate behind" : "col-rate";
    const tip = behind ? ` title="신라보다 ${r.discount_rate - shillaRate}%p 높음 — 신라 열세"` : "";
    return `<td data-label="${shop} 할인률" class="${cls}"${tip}><span class="rate">${rate}</span>${soldout}</td>`;
  };

  const links = SHOP_ORDER
    .filter((s) => shops[s] && shops[s].found && shops[s].url)
    .map((s) => `<a class="icon-link" href="${escapeHtml(shops[s].url)}" target="_blank" rel="noopener" title="${s}">${s} ↗</a>`)
    .join("");

  // 정렬용 값: 할인율은 숫자만(미취급·로그인 시·품절은 빈값 → 정렬 시 하단으로)
  const rateVal = (shop) => {
    const r = shops[shop];
    return r && r.found && r.discount_rate != null ? r.discount_rate : "";
  };
  const priceVal = shops["신라"] && shops["신라"].found && shops["신라"].price_origin != null
    ? Number(shops["신라"].price_origin) : "";

  return `
    <tr id="cmp-row-${num}" data-num="${num}" data-sku="${escapeHtml(row.sku)}"
        data-brand="${escapeHtml(query.brand || "")}" data-branden="${escapeHtml(query.brand_en || "")}"
        data-category="${escapeHtml(query.category || "")}" data-name="${escapeHtml(query.product || "")}"
        data-ref="${escapeHtml(query.ref_no || "")}" data-price="${priceVal}"
        data-shilla="${rateVal("신라")}" data-lotte="${rateVal("롯데")}" data-ssg="${rateVal("신세계")}">
      <td data-label="#" class="col-num">${num}</td>
      <td data-label="국문 브랜드명">${escapeHtml(query.brand || "")}</td>
      <td data-label="영문 브랜드명">${escapeHtml(query.brand_en || "")}</td>
      <td data-label="상품유형">${escapeHtml(query.category || "")}</td>
      <td data-label="상품명" class="col-name">${escapeHtml(query.product || "")}</td>
      <td data-label="SKU" class="col-sku">${escapeHtml(row.sku)}</td>
      <td data-label="REF" class="col-ref">${escapeHtml(query.ref_no || "")}</td>
      <td data-label="정가(USD)" class="col-rate">${fmtPrice(shops["신라"])}</td>
      ${rateCell("신라")}
      ${rateCell("롯데")}
      ${rateCell("신세계")}
      <td data-label="링크" class="link-cell">${links || "—"}</td>
    </tr>`;
}

// 조회 결과 1건 → 엑셀용 구조화 행(면세점별 할인률 + 가격확인 링크, 별도 컬럼).
function extractExportRow(data, row) {
  const shops = (data && data.shops) || {};
  const errors = (data && data.errors) || {};
  const query = (data && data.query) || {};
  const cell = (s) => {
    const r = shops[s];
    if (r && r.unsupported) return { rate: "미운영", url: null };
    if (!r || !r.found) return { rate: errors[s] ? "조회 오류" : "미취급", url: null };
    let rate = r.discount_rate != null ? r.discount_rate + "%"
      : (r.login_required ? "로그인 시 확인" : "");
    if (r.soldout && rate) rate += " (품절)";
    return { rate, url: r.url || null };
  };
  const shillaShop = shops["신라"];
  const priceOrigin = shillaShop && shillaShop.found && shillaShop.price_origin != null
    ? `$${Number(shillaShop.price_origin).toFixed(0)}` : "";
  return {
    sku: row.sku || "",
    brand_kr: query.brand || "",
    brand_en: query.brand_en || "",
    category: query.category || "",
    product: query.product || row.sku || "",
    ref_no: query.ref_no || "",
    price_origin: priceOrigin,
    shops: { "신라": cell("신라"), "롯데": cell("롯데"), "신세계": cell("신세계") },
  };
}

// 서버에서 .xlsx 생성(할인률과 분리된 면세점별 '가격확인 링크' 컬럼) → 다운로드
async function downloadExcel() {
  if (!exportRows.length) return;
  let blob;
  try {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: exportRows }),
    });
    if (!res.ok) throw new Error("export-failed");
    blob = await res.blob();
  } catch (err) {
    flashHint("엑셀 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
    return;
  }
  const url = URL.createObjectURL(blob);
  const d = new Date();
  const stamp =
    d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0");
  const a = document.createElement("a");
  a.href = url;
  a.download = `면세점_가격비교_${stamp}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// 정가 셀: 신라 price_origin 사용
function fmtPrice(shopData) {
  if (!shopData || !shopData.found) return `<span class="na">—</span>`;
  const v = shopData.price_origin;
  if (v == null) return `<span class="na">—</span>`;
  return `$${Number(v).toFixed(0)}`;
}

// 조회 실패/미발견 행: 컬럼 형태는 유지하고 값만 "—"
function buildErrorRow(row, msg, num) {
  const errMsg = msg ? `<span style="color:#99202a;font-size:.8rem">${escapeHtml(msg)}</span>` : "—";
  return `
    <tr data-num="${num || ""}">
      <td data-label="#" class="col-num">${num || ""}</td>
      <td data-label="SKU" class="col-sku">${escapeHtml(row.sku || "")}</td>
      <td data-label="국문 브랜드명" class="na" colspan="10">${errMsg}</td>
    </tr>`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
