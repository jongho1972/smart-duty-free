const results = document.getElementById("results");
const hint = document.getElementById("hint");
const SHOP_ORDER = ["신라", "롯데", "신세계"];

const batchForm = document.getElementById("batch-form");
const batchInput = document.getElementById("batch-input");
const batchBtn = document.getElementById("batch-btn");
const MAX_BATCH_ROWS = 20;

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
            <th>SKU</th><th>상품명 (신라)</th><th>면세가</th>
            <th>신라 할인률</th><th>롯데 할인률</th><th>신세계 할인률</th><th>가격확인 링크</th>
          </tr>
        </thead>
        <tbody id="compare-body"></tbody>
      </table>
    </div>
    <p class="note">· 신라에서 SKU로 상품을 확정한 뒤 REF.NO로 롯데·신세계를 검색합니다.<br/>
    · <b>면세가</b>는 정가(USD) 대표값이며, <b>엑셀 다운로드</b> 시 면세점별 <b>가격확인 링크</b> 컬럼이 포함됩니다.</p>`;
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
        const res = await fetch(`/api/compare-by-sku?${params.toString()}`);
        data = await res.json();
        tr = buildProductRow(data, row);
      } catch (err) {
        data = {};
        tr = buildErrorRow(row);
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
    flashHint(`한 번에 최대 ${MAX_BATCH_ROWS}건까지만 비교합니다. 나머지는 다시 나눠 조회해 주세요.`);
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

function fmtUsd(v) {
  if (v === null || v === undefined) return null;
  return "$" + (Number.isInteger(v) ? v : v.toFixed(2));
}

// 조회 결과 1건 → 상품별 한 행(<tr>).
// 상품명·브랜드명은 신라 조회 결과(data.query)에서 가져온다.
function buildProductRow(data, row) {
  if (data.error) return buildErrorRow(row, data.error);

  const shops = data.shops || {};
  const errors = data.errors || {};
  const query = data.query || {};

  const productName = query.product || "";
  const brandName = query.brand || "";
  const refNo = query.ref_no || "";

  // 면세가: 정가 우선, 없으면 판매가 폴백(할인 없는 상품 대응)
  const faceUsd = faceValue(shops);

  const rateCell = (shop) => {
    const r = shops[shop];
    if (!r || !r.found) {
      return `<td data-label="${shop} 할인률" class="na">${errors[shop] ? "실패" : "—"}</td>`;
    }
    const rate = r.discount_rate != null ? r.discount_rate + "%" : "—";
    return `<td data-label="${shop} 할인률"><span class="rate">${rate}</span></td>`;
  };

  const links = SHOP_ORDER
    .filter((s) => shops[s] && shops[s].found && shops[s].url)
    .map((s) => `<a class="shop-link" href="${escapeHtml(shops[s].url)}" target="_blank" rel="noopener">${s} ↗</a>`)
    .join("");

  const skuCell = refNo
    ? `<span style="font-weight:700">${escapeHtml(row.sku)}</span><br/><small style="color:#6b7280">REF: ${escapeHtml(refNo)}</small>`
    : `<span style="font-weight:700">${escapeHtml(row.sku)}</span>`;

  const nameCell = brandName
    ? `${escapeHtml(productName)}<br/><small style="color:#6b7280">${escapeHtml(brandName)}</small>`
    : escapeHtml(productName || "—");

  return `
    <tr>
      <td data-label="SKU">${skuCell}</td>
      <td data-label="상품명 (신라)">${nameCell}</td>
      <td data-label="면세가">${faceUsd != null ? fmtUsd(faceUsd) : "—"}</td>
      ${rateCell("신라")}
      ${rateCell("롯데")}
      ${rateCell("신세계")}
      <td data-label="가격확인" class="link-cell">${links || "—"}</td>
    </tr>`;
}

// 면세가 대표값: 정가(price_origin) 우선, 없으면 판매가(price_sale)로 폴백.
// 할인 없는 상품은 정가가 비고 판매가만 오므로, 폴백이 없으면 가격이 있어도 "—"로 보인다.
function faceValue(shops) {
  for (const s of SHOP_ORDER) {
    const r = shops[s];
    if (r && r.found && r.price_origin != null) return r.price_origin;
  }
  for (const s of SHOP_ORDER) {
    const r = shops[s];
    if (r && r.found && r.price_sale != null) return r.price_sale;
  }
  return null;
}

// 조회 결과 1건 → 엑셀용 구조화 행(면세점별 할인률 + 가격확인 링크, 별도 컬럼).
function extractExportRow(data, row) {
  const shops = (data && data.shops) || {};
  const errors = (data && data.errors) || {};
  const query = (data && data.query) || {};
  const faceUsd = faceValue(shops);
  const cell = (s) => {
    const r = shops[s];
    if (!r || !r.found) return { rate: errors[s] ? "실패" : "", url: null };
    return {
      rate: r.discount_rate != null ? r.discount_rate + "%" : "",
      url: r.url || null,
    };
  };
  return {
    sku: row.sku || "",
    product: query.product || row.sku || "",
    brand: query.brand || "",
    face: faceUsd != null ? fmtUsd(faceUsd) : "",
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

// 조회 실패/미발견 행: 컬럼 형태는 유지하고 값만 "—"
function buildErrorRow(row, msg) {
  const errMsg = msg ? `<small style="color:#99202a">${escapeHtml(msg)}</small>` : "—";
  return `
    <tr>
      <td data-label="SKU">${escapeHtml(row.sku || "")}</td>
      <td data-label="상품명 (신라)" class="na">${errMsg}</td>
      <td data-label="면세가" class="na">—</td>
      <td data-label="신라 할인률" class="na">—</td>
      <td data-label="롯데 할인률" class="na">—</td>
      <td data-label="신세계 할인률" class="na">—</td>
      <td data-label="가격확인" class="na">—</td>
    </tr>`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
