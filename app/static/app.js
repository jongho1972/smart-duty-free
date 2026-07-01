const results = document.getElementById("results");
const hint = document.getElementById("hint");
const SHOP_ORDER = ["신라", "롯데", "신세계"];

// ── 면세점 계정 관리 (sessionStorage) ──────────────────────────────────────
function loadCreds() {
  return {
    lotteId: sessionStorage.getItem("df_lotte_id") || "",
    lottePw: sessionStorage.getItem("df_lotte_pw") || "",
    ssgId:   sessionStorage.getItem("df_ssg_id")   || "",
    ssgPw:   sessionStorage.getItem("df_ssg_pw")   || "",
  };
}

function updateCredBadge() {
  const c = loadCreds();
  const badge = document.getElementById("cred-badge");
  if (!badge) return;
  const hasL = c.lotteId && c.lottePw;
  const hasS = c.ssgId && c.ssgPw;
  if (hasL && hasS) {
    badge.textContent = "L.POINT·신세계 저장됨";
  } else if (hasL) {
    badge.textContent = "L.POINT 저장됨";
  } else if (hasS) {
    badge.textContent = "신세계 저장됨";
  } else {
    badge.textContent = "미입력";
  }
  badge.className = "cred-badge" + (hasL || hasS ? " saved" : "");
}

(function initCreds() {
  const c = loadCreds();
  const li = document.getElementById("lotte-id");
  const lp = document.getElementById("lotte-pw");
  const si = document.getElementById("ssg-id");
  const sp = document.getElementById("ssg-pw");
  if (li) li.value = c.lotteId;
  if (lp) lp.value = c.lottePw;
  if (si) si.value = c.ssgId;
  if (sp) sp.value = c.ssgPw;
  updateCredBadge();

  const reloginBtn = document.getElementById("cred-relogin-btn");
  const loginStatus = document.getElementById("cred-login-status");
  reloginBtn?.addEventListener("click", async () => {
    // 현재 입력값을 sessionStorage에 먼저 저장
    sessionStorage.setItem("df_lotte_id", (li?.value || "").trim());
    sessionStorage.setItem("df_lotte_pw", lp?.value || "");
    sessionStorage.setItem("df_ssg_id",   (si?.value || "").trim());
    sessionStorage.setItem("df_ssg_pw",   sp?.value || "");
    updateCredBadge();

    reloginBtn.disabled = true;
    reloginBtn.textContent = "로그인 중…";
    if (loginStatus) loginStatus.hidden = true;
    try {
      const c = loadCreds();
      const hdrs = {};
      if (c.lotteId) hdrs["X-Lotte-Id"] = c.lotteId;
      if (c.lottePw) hdrs["X-Lotte-Pw"] = c.lottePw;
      if (c.ssgId)   hdrs["X-Ssg-Id"]   = c.ssgId;
      if (c.ssgPw)   hdrs["X-Ssg-Pw"]   = c.ssgPw;
      const res = await fetch("/api/login-reset", { method: "POST", headers: hdrs });
      const data = await res.json();
      if (loginStatus) {
        const allOk = data.lotte_login && data.ssg_login;
        if (allOk) {
          loginStatus.textContent = "L.POINT ✓ 신세계 ✓";
          loginStatus.className = "cred-login-status ok";
        } else {
          const parts = [];
          if (!data.lotte_login) parts.push("L.POINT");
          if (!data.ssg_login)   parts.push("신세계");
          loginStatus.textContent = parts.join("·") + " 미로그인 — 해당 면세점 할인율 조회가 제한될 수 있습니다.";
          loginStatus.className = "cred-login-status info";
        }
        loginStatus.hidden = false;
      }
    } catch {
      if (loginStatus) {
        loginStatus.textContent = "서버 연결 실패 — 잠시 후 다시 시도해 주세요.";
        loginStatus.className = "cred-login-status info";
        loginStatus.hidden = false;
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

// ?skus=sku1,sku2,... 파라미터로 진입 시 자동 입력·조회
(function () {
  const skusParam = new URLSearchParams(location.search).get("skus");
  if (!skusParam) return;
  const skus = skusParam.split(",").map((s) => s.trim()).filter(Boolean);
  if (!skus.length) return;
  batchInput.value = skus.join("\n");
  // DOM 렌더 완료 후 제출
  requestAnimationFrame(() => batchForm.dispatchEvent(new Event("submit")));
})();

// 엑셀(.xlsx) 다운로드용 누적 데이터 (면세점별 할인률+링크를 구조화해 보관)
let exportRows = [];

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
  const prog = document.getElementById("batch-progress");
  prog.hidden = false;

  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      prog.textContent = `조회 중… (${i + 1}/${rows.length}) SKU: ${row.sku}`;
      let tr, data = {};
      try {
        const params = new URLSearchParams({ sku: row.sku });
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

  if (truncated) {
    flashHint(`한 번에 최대 ${MAX_BATCH_ROWS}개까지만 비교합니다. 나머지는 다시 나눠 조회해 주세요.`);
  }
});

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
    if (!r || !r.found) {
      return `<td data-label="${shop} 할인률" class="col-rate na">${errors[shop] ? "조회 실패" : "—"}</td>`;
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
