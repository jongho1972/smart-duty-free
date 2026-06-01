const form = document.getElementById("search-form");
const results = document.getElementById("results");
const hint = document.getElementById("hint");
const submitBtn = document.getElementById("submit-btn");
const SHOP_ORDER = ["신라", "롯데", "신세계"];

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const brand = document.getElementById("brand").value.trim();
  const product = document.getElementById("product").value.trim();
  if (!brand && !product) {
    flashHint("브랜드명 또는 상품명을 입력해 주세요.");
    return;
  }

  setLoading(true);
  results.hidden = true;
  try {
    const params = new URLSearchParams({ brand, product });
    const res = await fetch(`/api/compare?${params.toString()}`);
    if (res.status === 401) {
      if (window.__showAuthGate) window.__showAuthGate();
      return;
    }
    const data = await res.json();
    render(data, brand, product);
  } catch (err) {
    results.hidden = false;
    results.innerHTML = `<div class="error-box">조회 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.</div>`;
  } finally {
    setLoading(false);
  }
});

function setLoading(on) {
  document.body.classList.toggle("loading", on);
  submitBtn.disabled = on;
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
function fmtKrw(v) {
  if (v === null || v === undefined) return null;
  return v.toLocaleString("ko-KR") + "원";
}

function render(data, brand, product) {
  results.hidden = false;
  if (data.error) {
    results.innerHTML = `<div class="error-box">${data.error}</div>`;
    return;
  }

  const shops = data.shops || {};
  const found = SHOP_ORDER.map((s) => shops[s]).filter((s) => s && s.found);

  if (found.length === 0) {
    results.innerHTML = `
      <div class="error-box">
        입력하신 조건(<b>${escapeHtml(brand)} ${escapeHtml(product)}</b>)에 해당하는 상품을
        3개 면세점에서 찾지 못했습니다.<br/>
        모델 코드를 더 정확히 입력하거나(예: 색상코드 포함) 영문/숫자 표기를 확인해 주세요.
      </div>`;
    return;
  }

  // 대표 상품명/브랜드 (가장 정보가 많은 매칭에서)
  const repName = found[0].name || product;
  const repBrand = (found.find((f) => f.brand) || {}).brand || brand;

  // 최저 판매가(USD) 찾기 → best 강조
  let bestShop = null;
  let bestPrice = Infinity;
  for (const s of SHOP_ORDER) {
    const r = shops[s];
    if (r && r.found && r.price_sale != null && r.price_sale < bestPrice) {
      bestPrice = r.price_sale;
      bestShop = s;
    }
  }

  const rows = SHOP_ORDER.map((shop) => {
    const r = shops[shop] || { found: false };
    const isBest = shop === bestShop;
    if (!r.found) {
      const errored = (data.errors || {})[shop];
      return `
        <tr>
          <td data-label="면세점"><span class="shop-tag shop-${shop}">${shop}</span></td>
          <td data-label="상품명" class="na">${errored ? "조회 실패" : "해당 상품 없음"}</td>
          <td data-label="정가" class="na">—</td>
          <td data-label="할인율" class="na">—</td>
          <td data-label="판매가($)" class="na">—</td>
          <td data-label="판매가(원)" class="na">—</td>
          <td data-label="링크" class="na">—</td>
        </tr>`;
    }
    const krw = fmtKrw(r.price_krw);
    const krwCls = r.krw_estimated ? "krw-approx" : "price-krw";
    const krwTxt = krw ? (r.krw_estimated ? "≈ " + krw : krw) : "—";
    return `
      <tr class="${isBest ? "best" : ""}">
        <td data-label="면세점"><span class="shop-tag shop-${shop}">${shop}</span></td>
        <td data-label="상품명">${escapeHtml(r.name || "")}${r.soldout ? '<span class="badge-soldout">품절</span>' : ""}</td>
        <td data-label="정가">${fmtUsd(r.price_origin) ? `<span class="price-origin">${fmtUsd(r.price_origin)}</span>` : "—"}</td>
        <td data-label="할인율"><span class="rate" style="color:${isBest ? "var(--best)" : "var(--crimson)"}">${r.discount_rate != null ? r.discount_rate + "%" : "—"}</span></td>
        <td data-label="판매가($)"><span class="price-sale">${fmtUsd(r.price_sale) || "—"}</span>${isBest ? '<span class="badge-best">최저가</span>' : ""}</td>
        <td data-label="판매가(원)"><span class="${krwCls}">${krwTxt}</span></td>
        <td data-label="링크">${r.url ? `<a class="go-link" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">바로가기 ↗</a>` : "—"}</td>
      </tr>`;
  }).join("");

  results.innerHTML = `
    <div class="result-head">
      <h2>${escapeHtml(repBrand)} · ${escapeHtml(repName)}</h2>
      <span class="sub">검색어 “${escapeHtml(data.query.keyword)}” 기준 · 환율 $1≈${data.exchange_rate.toLocaleString("ko-KR")}원</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>면세점</th><th>상품명</th><th>정가</th><th>할인율</th>
            <th>판매가($)</th><th>판매가(원)</th><th>가격 확인</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="note">· “판매가(원)” 중 <b>≈</b> 표시는 달러 판매가에 환율을 적용한 추정값입니다(롯데는 사이트 제공 정확값).<br/>
    · 면세점별로 상품명 표기(예: 신라·롯데 “파도바”, 신세계 “VVCC25”)가 달라도 동일 모델이면 함께 비교됩니다.</p>
  `;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
