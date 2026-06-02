const results = document.getElementById("results");
const hint = document.getElementById("hint");
const SHOP_ORDER = ["신라", "롯데", "신세계"];

const batchForm = document.getElementById("batch-form");
const batchInput = document.getElementById("batch-input");
const batchBtn = document.getElementById("batch-btn");
const MAX_BATCH_ROWS = 20;

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
  results.innerHTML = `
    <div class="table-wrap">
      <table class="compare-table">
        <thead>
          <tr>
            <th>상품명</th><th>브랜드명</th><th>면세가</th>
            <th>신라 할인률</th><th>롯데 할인률</th><th>신세계 할인률</th><th>가격확인</th>
          </tr>
        </thead>
        <tbody id="compare-body"></tbody>
      </table>
    </div>
    <p class="note">· 상품명·브랜드명은 입력값 그대로이며, <b>면세가</b>는 정가(USD) 대표값입니다.<br/>
    · 가격·할인율은 조회 시점의 각 인터넷면세점 공개 정보 기준입니다.</p>`;
  const tbody = results.querySelector("#compare-body");
  const prog = document.createElement("div");
  prog.className = "batch-progress";
  results.appendChild(prog);

  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      prog.textContent = `조회 중… (${i + 1}/${rows.length}) ${row.raw}`;
      let tr;
      try {
        const params = new URLSearchParams({ brand: row.brand, product: row.product });
        const res = await fetch(`/api/compare?${params.toString()}`);
        if (res.status === 401) {
          if (window.__showAuthGate) window.__showAuthGate();
          return;
        }
        const data = await res.json();
        tr = buildProductRow(data, row);
      } catch (err) {
        tr = buildErrorRow(row);
      }
      tbody.insertAdjacentHTML("beforeend", tr);
    }
  } finally {
    prog.remove();
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

// --- 클립보드 붙여넣기 버튼 ---
document.querySelectorAll(".paste-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        throw new Error("clipboard-unavailable");
      }
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) {
        flashHint("클립보드가 비어 있습니다.");
        input.focus();
        return;
      }
      input.value = text;
      input.focus();
      markPasted(btn);
    } catch (err) {
      // 권한 거부·구형 브라우저·비보안 컨텍스트 → 포커스 폴백
      input.focus();
      flashHint("자동 붙여넣기가 막혀 있어요. 입력칸에서 직접 붙여넣기(⌘V / Ctrl+V) 해 주세요.");
    }
  });
});

function markPasted(btn) {
  const orig = btn.textContent;
  btn.classList.add("done");
  btn.textContent = "붙여넣음";
  setTimeout(() => {
    btn.classList.remove("done");
    btn.textContent = orig;
  }, 1300);
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
