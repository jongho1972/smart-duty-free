const results = document.getElementById("results");
const hint = document.getElementById("hint");
const SHOP_ORDER = ["신라", "롯데", "신세계"];

const batchForm = document.getElementById("batch-form");
const batchInput = document.getElementById("batch-input");
const batchBtn = document.getElementById("batch-btn");
const MAX_BATCH_ROWS = 20;

// CSV 다운로드용 누적 데이터 (표와 동일한 7개 컬럼)
const CSV_HEADER = ["상품명", "브랜드명", "면세가", "신라 할인률", "롯데 할인률", "신세계 할인률", "가격확인 링크"];
let csvRows = [];

// 일괄 입력 파싱: 한 줄 = "모델코드〈Tab 또는 2칸+ 공백〉브랜드"
function parseBatch(raw) {
  return (raw || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\t+|\s{2,}/).map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        return { product: parts[0], brand: parts.slice(1).join(" "), raw: line };
      }
      return { product: parts[0] || line, brand: "", raw: line };
    });
}

batchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  let rows = parseBatch(batchInput.value);
  if (rows.length === 0) {
    flashHint("비교할 상품 목록을 한 줄에 하나씩 붙여넣어 주세요.");
    return;
  }
  let truncated = false;
  if (rows.length > MAX_BATCH_ROWS) {
    rows = rows.slice(0, MAX_BATCH_ROWS);
    truncated = true;
  }

  setBatchLoading(true);
  results.hidden = false;
  csvRows = [];
  results.innerHTML = `
    <div class="results-toolbar">
      <button type="button" id="csv-btn" disabled>CSV 다운로드</button>
    </div>
    <div class="table-wrap">
      <table class="compare-table">
        <thead>
          <tr>
            <th>상품명</th><th>브랜드명</th><th>면세가</th>
            <th>신라 할인률</th><th>롯데 할인률</th><th>신세계 할인률</th><th>가격확인 링크</th>
          </tr>
        </thead>
        <tbody id="compare-body"></tbody>
      </table>
    </div>
    <p class="note">· 상품명·브랜드명은 입력값 그대로이며, <b>면세가</b>는 정가(USD) 대표값입니다.</p>`;
  const tbody = results.querySelector("#compare-body");
  const csvBtn = results.querySelector("#csv-btn");
  csvBtn.addEventListener("click", downloadCsv);
  const prog = document.getElementById("batch-progress");
  prog.hidden = false;

  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      prog.textContent = `조회 중… (${i + 1}/${rows.length}) ${row.raw}`;
      let tr, data = {};
      try {
        const params = new URLSearchParams({ brand: row.brand, product: row.product });
        const res = await fetch(`/api/compare?${params.toString()}`);
        if (res.status === 401) {
          if (window.__showAuthGate) window.__showAuthGate();
          return;
        }
        data = await res.json();
        tr = buildProductRow(data, row);
      } catch (err) {
        data = {};
        tr = buildErrorRow(row);
      }
      tbody.insertAdjacentHTML("beforeend", tr);
      csvRows.push(extractCsvRow(data, row));
    }
  } finally {
    prog.hidden = true;
    prog.textContent = "";
    csvBtn.disabled = csvRows.length === 0;
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

// 조회 결과 1건 → 상품별 한 행(<tr>). 공기관 제출용 심플 양식: 뱃지 없음.
// 상품명·브랜드명은 입력값(row) 그대로 표기한다.
function buildProductRow(data, row) {
  if (data.error) return buildErrorRow(row);

  const shops = data.shops || {};
  const errors = data.errors || {};

  // 면세가(대표 정가, 신라 우선)
  let faceUsd = null;
  for (const s of SHOP_ORDER) {
    const r = shops[s];
    if (r && r.found && r.price_origin != null) { faceUsd = r.price_origin; break; }
  }

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

  return `
    <tr>
      <td data-label="상품명">${escapeHtml(row.product || row.raw || "")}</td>
      <td data-label="브랜드명">${escapeHtml(row.brand || "")}</td>
      <td data-label="면세가">${faceUsd != null ? fmtUsd(faceUsd) : "—"}</td>
      ${rateCell("신라")}
      ${rateCell("롯데")}
      ${rateCell("신세계")}
      <td data-label="가격확인" class="link-cell">${links || "—"}</td>
    </tr>`;
}

// 조회 결과 1건 → CSV 한 행(표와 동일 7컬럼). 링크는 "면세점 URL" 형태.
function extractCsvRow(data, row) {
  const shops = (data && data.shops) || {};
  const errors = (data && data.errors) || {};
  let faceUsd = null;
  for (const s of SHOP_ORDER) {
    const r = shops[s];
    if (r && r.found && r.price_origin != null) { faceUsd = r.price_origin; break; }
  }
  const rateOf = (s) => {
    const r = shops[s];
    if (!r || !r.found) return errors[s] ? "실패" : "";
    return r.discount_rate != null ? r.discount_rate + "%" : "";
  };
  const links = SHOP_ORDER
    .filter((s) => shops[s] && shops[s].found && shops[s].url)
    .map((s) => `${s} ${shops[s].url}`)
    .join(" | ");
  return [
    row.product || row.raw || "",
    row.brand || "",
    faceUsd != null ? fmtUsd(faceUsd) : "",
    rateOf("신라"), rateOf("롯데"), rateOf("신세계"),
    links,
  ];
}

// CSV 문자열 생성(엑셀 한글 호환 위해 UTF-8 BOM 부착)
function buildCsv(header, dataRows) {
  const esc = (s) => {
    const v = String(s == null ? "" : s);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const lines = [header, ...dataRows].map((r) => r.map(esc).join(","));
  return "﻿" + lines.join("\r\n");
}

function downloadCsv() {
  if (!csvRows.length) return;
  const csv = buildCsv(CSV_HEADER, csvRows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const d = new Date();
  const stamp =
    d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0");
  const a = document.createElement("a");
  a.href = url;
  a.download = `면세점_가격비교_${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// 조회 실패/미발견 행: 컬럼 형태는 유지하고 값만 "—"
function buildErrorRow(row) {
  return `
    <tr>
      <td data-label="상품명">${escapeHtml(row.product || row.raw || "")}</td>
      <td data-label="브랜드명">${escapeHtml(row.brand || "")}</td>
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
