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
      // 결과가 이미 있으면 같은 SKU 목록으로 해당 몰 자동 재조회
      if (lastSkus.length) {
        runBatch(lastSkus.map((sku) => ({ sku })));
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

// 로그인 결과를 배지·상태 문구에 반영. result가 없으면(첫 방문 등) 둘 다 숨긴다.
function renderLoginResult(loginStatus, credBadge, result) {
  if (!result) {
    if (loginStatus) loginStatus.hidden = true;
    if (credBadge) credBadge.hidden = true;
    return false;
  }
  const { lotteOk, ssgOk } = result;
  const anyOk = lotteOk || ssgOk;
  const allOk = lotteOk && ssgOk;
  if (loginStatus) {
    if (allOk) {
      loginStatus.textContent = "L.POINT ✓ 신세계 ✓ 로그인 성공";
      loginStatus.className = "cred-login-status ok";
    } else if (anyOk) {
      const okName = lotteOk ? "L.POINT" : "신세계";
      const failName = lotteOk ? "신세계" : "L.POINT";
      loginStatus.textContent = `${okName} ✓ 로그인 성공 · ${failName} 미로그인`;
      loginStatus.className = "cred-login-status ok";
    } else {
      loginStatus.textContent = "L.POINT·신세계 로그인 실패 — 아이디·비밀번호를 확인해 주세요.";
      loginStatus.className = "cred-login-status fail";
    }
    loginStatus.hidden = false;
  }
  // 접힌 상태에서도 결과가 보이도록 배지에 어느 면세점에 로그인됐는지 표시
  if (credBadge) {
    if (allOk) {
      credBadge.textContent = "L.POINT·신세계 로그인 성공";
      credBadge.className = "cred-badge saved";
    } else if (anyOk) {
      const okName = lotteOk ? "L.POINT" : "신세계";
      const failName = lotteOk ? "신세계" : "L.POINT";
      credBadge.textContent = `${okName} 성공 · ${failName} 실패`;
      credBadge.className = "cred-badge partial";
    } else {
      credBadge.textContent = "로그인 실패";
      credBadge.className = "cred-badge failed";
    }
    credBadge.hidden = false;
  }
  return anyOk;
}

(function initCreds() {
  const c = loadCreds();
  const credPanel = document.getElementById("cred-panel");
  const credBadge = document.getElementById("cred-badge");
  const li = document.getElementById("lotte-id");
  const lp = document.getElementById("lotte-pw");
  const si = document.getElementById("ssg-id");
  const sp = document.getElementById("ssg-pw");
  if (li) li.value = c.lotteId;
  if (lp) lp.value = c.lottePw;
  if (si) si.value = c.ssgId;
  if (sp) sp.value = c.ssgPw;

  const reloginBtn = document.getElementById("cred-relogin-btn");
  const loginStatus = document.getElementById("cred-login-status");

  // 이전 로그인 결과가 있으면 재조회 없이 배지·상태 문구를 그대로 복원
  const cachedAnyOk = renderLoginResult(loginStatus, credBadge, loadLoginResult());
  if (cachedAnyOk && credPanel) credPanel.open = false;

  reloginBtn?.addEventListener("click", async () => {
    // 현재 입력값을 sessionStorage에 먼저 저장
    sessionStorage.setItem("df_lotte_id", (li?.value || "").trim());
    sessionStorage.setItem("df_lotte_pw", lp?.value || "");
    sessionStorage.setItem("df_ssg_id",   (si?.value || "").trim());
    sessionStorage.setItem("df_ssg_pw",   sp?.value || "");

    reloginBtn.disabled = true;
    reloginBtn.textContent = "로그인 중…";
    if (loginStatus) loginStatus.hidden = true;
    if (credBadge) credBadge.hidden = true;
    try {
      const c = loadCreds();
      const hdrs = {};
      if (c.lotteId) hdrs["X-Lotte-Id"] = c.lotteId;
      if (c.lottePw) hdrs["X-Lotte-Pw"] = c.lottePw;
      if (c.ssgId)   hdrs["X-Ssg-Id"]   = c.ssgId;
      if (c.ssgPw)   hdrs["X-Ssg-Pw"]   = c.ssgPw;
      const res = await fetch("/api/login-reset", { method: "POST", headers: hdrs });
      const data = await res.json();
      const lotteOk = !!data.lotte_login;
      const ssgOk = !!data.ssg_login;
      saveLoginResult(lotteOk, ssgOk);
      // 로그인에 성공한 경우에만 입력창을 접어 화면을 정리하고,
      // 실패 시에는 아이디·비밀번호를 바로 고칠 수 있도록 펼친 채 둔다.
      const anyOk = renderLoginResult(loginStatus, credBadge, { lotteOk, ssgOk });
      if (anyOk && credPanel) credPanel.open = false;
    } catch {
      if (loginStatus) {
        loginStatus.textContent = "서버 연결 실패 — 잠시 후 다시 시도해 주세요.";
        loginStatus.className = "cred-login-status fail";
        loginStatus.hidden = false;
      }
      if (credBadge) {
        credBadge.textContent = "로그인 실패";
        credBadge.className = "cred-badge failed";
        credBadge.hidden = false;
      }
    } finally {
      reloginBtn.disabled = false;
      reloginBtn.textContent = "로그인";
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
  await runBatch(rows);
  if (truncated) {
    flashHint(`한 번에 최대 ${MAX_BATCH_ROWS}개까지만 비교합니다. 나머지는 다시 나눠 조회해 주세요.`);
  }
});

// 실제 일괄 조회 실행 — 폼 제출과 몰 토글 자동 재조회가 공유
async function runBatch(rows) {
  lastSkus = rows.map((r) => r.sku);
  setBatchLoading(true);
  results.hidden = false;
  exportRows = [];
  results.innerHTML = `
    <div class="results-toolbar">
      <button type="button" id="excel-btn" disabled>엑셀 다운로드</button>
    </div>
    <div class="table-wrap">
      <table class="compare-table">
        <thead>
          <tr>
            <th class="col-num">#</th>
            <th class="col-sku">SKU.NO</th>
            <th>국문 브랜드명</th>
            <th>영문 브랜드명</th>
            <th>상품유형</th>
            <th class="col-name">상품명</th>
            <th>REF.NO</th>
            <th class="col-rate">정가(USD)</th>
            <th class="col-rate">신라</th>
            <th class="col-rate">롯데</th>
            <th class="col-rate">신세계</th>
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
  const prog = document.getElementById("batch-progress");
  prog.hidden = false;

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
      exportRows.push(extractExportRow(data, row));
    }
  } finally {
    prog.hidden = true;
    prog.textContent = "";
    excelBtn.disabled = exportRows.length === 0;
    setBatchLoading(false);
  }
}

function setBatchLoading(on) {
  document.body.classList.toggle("loading", on);
  batchBtn.disabled = on;
}

function flashHint(msg) {
  hint.textContent = msg;
  hint.style.color = "#99202a";
  setTimeout(() => (hint.style.color = ""), 2600);
}

// 조회 결과 1건 → sku_lookup 포맷 행 + 경쟁사 할인률 컬럼
function buildProductRow(data, row, num) {
  if (data.error) return buildErrorRow(row, data.error, num);

  const shops = data.shops || {};
  const errors = data.errors || {};
  const query = data.query || {};

  const rateCell = (shop) => {
    const r = shops[shop];
    if (r && r.unsupported) {
      return `<td data-label="${shop} 할인률" class="col-rate na">미운영</td>`;
    }
    if (!r || !r.found) {
      return `<td data-label="${shop} 할인률" class="col-rate na">${errors[shop] ? "조회 실패" : "—"}</td>`;
    }
    // 롯데 할인율이 로그인에 막혔고 자격증명이 없어 정가만 온 경우 안내
    if (r.discount_rate == null && r.login_required) {
      return `<td data-label="${shop} 할인률" class="col-rate na"><span class="login-hint" title="로그인하면 할인율이 표시됩니다">🔒 로그인 시</span></td>`;
    }
    const rate = r.discount_rate != null ? r.discount_rate + "%" : "—";
    return `<td data-label="${shop} 할인률" class="col-rate"><span class="rate">${rate}</span></td>`;
  };

  const links = SHOP_ORDER
    .filter((s) => shops[s] && shops[s].found && shops[s].url)
    .map((s) => `<a class="icon-link" href="${escapeHtml(shops[s].url)}" target="_blank" rel="noopener" title="${s}">${s} ↗</a>`)
    .join("");

  return `
    <tr>
      <td data-label="#" class="col-num">${num}</td>
      <td data-label="SKU.NO" class="col-sku">${escapeHtml(row.sku)}</td>
      <td data-label="국문 브랜드명">${escapeHtml(query.brand || "")}</td>
      <td data-label="영문 브랜드명">${escapeHtml(query.brand_en || "")}</td>
      <td data-label="상품유형">${escapeHtml(query.category || "")}</td>
      <td data-label="상품명" class="col-name">${escapeHtml(query.product || "")}</td>
      <td data-label="REF.NO" class="col-ref">${escapeHtml(query.ref_no || "")}</td>
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
    if (!r || !r.found) return { rate: errors[s] ? "실패" : "", url: null };
    return {
      rate: r.discount_rate != null ? r.discount_rate + "%" : "",
      url: r.url || null,
    };
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
    <tr>
      <td data-label="#" class="col-num">${num || ""}</td>
      <td data-label="SKU.NO" class="col-sku">${escapeHtml(row.sku || "")}</td>
      <td data-label="국문 브랜드명" class="na" colspan="10">${errMsg}</td>
    </tr>`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
