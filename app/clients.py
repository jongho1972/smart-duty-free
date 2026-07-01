"""인터넷면세점 3사(신라·롯데·신세계) 가격 조회 클라이언트.

각 사이트의 접근 방식이 다르다.
- 롯데: 검색 결과가 서버 렌더링(HTML) → curl_cffi GET 후 BeautifulSoup 파싱.
- 신라: ajaxProducts 가 JSON API → 검색 페이지에서 CSRF 토큰/쿠키 획득 후 POST.
- 신세계: WAF(FECAS httpOnly 쿠키)가 일반 HTTP를 406 차단 → Playwright로 쿠키를
          수확해 캐시하고 curl_cffi 로 재사용(만료 시 자동 재수확).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import time
from dataclasses import dataclass, asdict
from typing import Optional

from bs4 import BeautifulSoup
from curl_cffi import requests as creq

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
TIMEOUT = 20


# ---------------------------------------------------------------------------
# 공통 데이터 모델
# ---------------------------------------------------------------------------
@dataclass
class Product:
    shop: str                 # 신라 / 롯데 / 신세계
    brand: str                # 표시 브랜드명
    name: str                 # 상품명(색상 포함)
    price_origin: Optional[float]   # 정가(USD)
    price_sale: Optional[float]     # 판매가(USD)
    discount_rate: Optional[int]    # 할인율(%)
    price_krw: Optional[int]        # 판매가(원) — 사이트 제공값 또는 환산 추정
    url: str                  # 상품 상세 링크
    soldout: bool = False

    def to_dict(self):
        return asdict(self)


def _norm(s: str) -> str:
    """매칭용 정규화: 대문자화 후 영문·숫자·한글만 남김(공백·기호 제거)."""
    return re.sub(r"[^0-9A-Z가-힣]", "", (s or "").upper())


def _tokens(s: str) -> list[str]:
    return [t for t in (_norm(x) for x in re.split(r"[\s/]+", s or "")) if t]


# 면세점은 영문 브랜드를 한글 표기로 인덱싱한다(RAYBAN→레이밴). 입력 브랜드(영문)와
# 결과 브랜드(한글)의 교차언어 일치를 잡으려면 동의어 사전이 필요하다.
# DF3/아이웨어·명품 중심으로 관리하며, 새 브랜드는 여기 추가한다.
BRAND_ALIASES = {
    "VEDIVERO": ("베디베로",),
    "HUNTER": ("헌터",),
    "ANNASUI": ("안나수이",),
    "ASUI": ("안나수이",),
    "JSTUART": ("질스튜어트",),
    "CARIN": ("카린",),
    "RAYBAN": ("레이밴", "레이반"),
    "TUMI": ("투미",),
    "CK": ("캘빈클라인", "씨케이"),
    "CALVINKLEIN": ("캘빈클라인",),
    "SWAROVSKI": ("스와로브스키",),
    "PANDORA": ("판도라",),
    "LAPIZSENSIBLE": ("라피즈", "라피즈센서블"),
    "GUCCI": ("구찌",),
    "LOEWE": ("로에베",),
    "DIOR": ("디올",),
    "OMEGA": ("오메가",),
    "TIFFANY": ("티파니",),
    "MONTBLANC": ("몽블랑",),
}

# 브랜드명에 흔히 붙는 카테고리 접미사(검색·매칭에서 브랜드 본명만 남기려고 제거)
_BRAND_SUFFIX = re.compile(r"\b(EYE|JEW|JEWE|JEWELRY|BAG|WATCH|SLG)\b", re.I)


def _clean_brand(brand: str) -> str:
    """브랜드 입력에서 (토산) 같은 괄호·카테고리 접미사·기호를 제거해 본명만 남긴다."""
    b = re.sub(r"\([^)]*\)", " ", brand or "")   # (토산) 등 괄호 주석 제거
    b = _BRAND_SUFFIX.sub(" ", b)
    b = re.sub(r"[^A-Za-z0-9가-힣 ]", " ", b)     # 점·하이픈 등 → 공백
    return " ".join(b.split())


def _brand_forms(brand: str) -> tuple[set, set]:
    """입력 브랜드의 (영문 토큰, 한글 표기) 집합을 _norm 형태로 반환.

    한글 표기는 동의어 사전 + 입력에 이미 한글이 있으면 그 토큰을 합친다.
    """
    cleaned = _clean_brand(brand)
    eng = {t for t in _tokens(cleaned) if not re.search(r"[가-힣]", t)}
    hangul = {t for t in _tokens(cleaned) if re.search(r"[가-힣]", t)}
    key = _norm(cleaned)
    for k, vals in BRAND_ALIASES.items():
        if key and key == k:
            hangul.update(_norm(v) for v in vals)
    return eng, hangul


def best_match(products: list[Product], brand: str, product: str,
               keyword: str = "") -> Optional[Product]:
    """브랜드+상품 기준으로 가장 잘 맞는 상품 1개 선택(정밀도 우선).

    면세점마다 취급 품목이 달라 '해당 모델 미보유'가 흔하고, 그때 사이트는
    부분일치로 무관한 상품을 잔뜩 반환한다. 그래서 확실할 때만 채택하고
    아니면 None('조회 안 됨')을 돌려준다. 후보 1건의 채택 조건:
      · 상품의 모델코드(숫자 포함 4자+)가 상품명에 그대로 등장 → 채택, 또는
      · 브랜드가 (동의어 포함) 일치하고 식별 상품 토큰이 잡힘 → 채택
    모델코드로 검색했는데 결과가 폭발(부분일치)하면, 'BR'·'50' 같은 2자
    우연 일치만으로는 채택하지 않고 3자+ 토큰이나 강한 토큰을 요구한다.
    """
    if not products:
        return None
    eng_brand, hangul_brand = _brand_forms(brand)
    # 상품 식별 토큰: 브랜드 토큰(영문·한글)은 제외(브랜드명이 상품명에도 들어가면 오인됨)
    brand_words = eng_brand | hangul_brand
    pt = [t for t in _tokens(product) if t not in brand_words]
    model_tokens = [t for t in pt
                    if len(t) >= 4 and any(ch.isdigit() for ch in t)]
    kw_is_model = bool(re.fullmatch(r"[A-Za-z0-9]+", keyword or "")) \
        and len(keyword) >= 4 and any(c.isdigit() for c in keyword)
    # 모델코드 검색인데 결과가 많으면(>=25) 부분일치 폭발 → 약한 토큰 불신
    flooded = kw_is_model and len(products) >= 25

    scored = []
    for p in products:
        nt = _norm(f"{p.brand} {p.name}")
        brand_hit = any(a in nt for a in (eng_brand | hangul_brand))
        pm = [t for t in pt if t in nt]
        strong = any(len(t) >= 4 for t in pm)
        ident = [t for t in pm if len(t) >= 3]       # 우연 일치에 강한 토큰
        model_hit = any(m in nt for m in model_tokens)

        if model_hit:
            valid = True                              # 모델코드 직접 등장 = 확실
        elif brand_hit:
            if flooded:
                valid = strong or len(ident) >= 1     # 약한 2자 우연 일치 배제
            else:
                valid = len(pm) >= 1 or strong
        else:
            valid = False                             # 브랜드·모델 모두 불일치 → 컷

        score = ((5 if model_hit else 0) + (3 if brand_hit else 0)
                 + 2 * len(pm) + (2 if strong else 0))
        scored.append((valid, score, not p.soldout, p))

    scored.sort(key=lambda x: (x[0], x[1], x[2]), reverse=True)
    valid, score, _, top = scored[0]
    return top if valid else None


# ---------------------------------------------------------------------------
# 롯데인터넷면세점
# ---------------------------------------------------------------------------
LOTTE_SEARCH = (
    "https://kor.lottedfs.com/kr/search?comSearchWord={kw}"
    "&comCollection=GOODS&comSort=RANK/DESC&comListCount=40"
)
LOTTE_DETAIL = "https://kor.lottedfs.com/kr/product/productDetail?prdNo={prd}&prdOptNo={opt}"


def _num(s: str) -> Optional[float]:
    m = re.search(r"[\d,.]+", s or "")
    if not m:
        return None
    try:
        return float(m.group().replace(",", ""))
    except ValueError:
        return None


# --- 롯데 로그인(회원가/할인율은 로그인해야 노출됨) -------------------------
# L.POINT 통합회원 로그인은 비밀번호를 클라이언트(KISA SEED 등)에서 암호화하므로
# raw HTTP 복제가 어렵다 → Playwright로 로그인해 세션 쿠키를 수확하고,
# 가벼운 curl_cffi 검색에 그 쿠키를 재사용한다(신세계 WAF 쿠키 패턴의 확장).
LOTTE_LOGIN_URL = "https://kor.lps.lottedfs.com/kr/member/login"
LOTTE_COOKIE_TTL = 30 * 60  # 30분
# 비로그인 시 검색 목록이 할인율 대신 노출하는 문구 → 로그인 성공/세션 판정에 사용
_LOTTE_LOGIN_MARKER = "로그인 후 할인율 확인"

_lotte_sessions: dict[str, dict] = {}  # cred_key → {cookies, at}
_lotte_lock = asyncio.Lock()


async def _do_lotte_login(lid: str, lpw: str) -> Optional[dict]:
    """L.POINT 로그인 후 lottedfs.com 세션 쿠키 수확.

    메모리 절약을 위해 신세계용 Chromium(_ssg_browser)을 공유하고, 로그인은
    격리된 새 컨텍스트에서 수행한 뒤 컨텍스트만 닫는다(별도 프로세스 미기동).
    """
    await _ssg_browser._ensure()  # 공유 Chromium 보장
    ctx = await _ssg_browser._browser.new_context(
        user_agent=UA, locale="ko-KR", viewport={"width": 1366, "height": 900})
    try:
        await ctx.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});")
        page = await ctx.new_page()
        await page.goto(LOTTE_LOGIN_URL, wait_until="domcontentloaded", timeout=30000)
        # ID 필드: #loginLpId(구) 또는 input[name=id] 시도
        id_sel = "#loginLpId" if await page.query_selector("#loginLpId") else "input[name='id']"
        pw_sel = "#password" if await page.query_selector("#password") else "input[name='password']"
        await page.fill(id_sel, lid)
        await page.fill(pw_sel, lpw)
        # doLpointLogin JS 함수 → 없으면 Enter 키 또는 버튼 클릭으로 폴백
        try:
            async with page.expect_navigation(wait_until="domcontentloaded", timeout=15000):
                fn_exists = await page.evaluate("() => typeof doLpointLogin === 'function'")
                if fn_exists:
                    await page.evaluate("() => doLpointLogin('N')")
                else:
                    # 로그인 버튼 직접 클릭 시도
                    btn = (await page.query_selector("button.loginBtn")
                           or await page.query_selector("button[type=submit]"))
                    if btn:
                        await btn.click()
                    else:
                        await page.keyboard.press("Enter")
        except Exception:
            await page.wait_for_timeout(4000)
        # 로그인 성공 검증: 검색 목록에 "로그인 후 할인율 확인"이 사라졌는지 확인.
        # (ID/PW 오류 등으로 실패하면 비로그인 쿠키를 성공으로 캐싱하지 않도록)
        try:
            await page.goto(LOTTE_SEARCH.format(kw="tumi"),
                            wait_until="domcontentloaded", timeout=20000)
            html = await page.content()
        except Exception:
            html = ""
        if not html or _LOTTE_LOGIN_MARKER in html:
            return None  # 로그인 미완료 → 캐싱하지 않음(다음 호출에서 재시도)
        cookies = await ctx.cookies()
        jar = {c["name"]: c["value"] for c in cookies
               if "lottedfs.com" in (c.get("domain") or "")}
        return jar or None
    finally:
        await ctx.close()


async def ensure_lotte_login(lid: Optional[str] = None, lpw: Optional[str] = None) -> tuple[Optional[dict], Optional[str]]:
    """유효한 롯데 세션 쿠키와 cred_key를 반환(필요 시 로그인). 자격증명 없으면 (None, None).

    lid/lpw 를 우선 사용하고, 없으면 환경변수 LOTTE_ID/LOTTE_PW 로 폴백한다.
    세션은 cred_key(자격증명 해시) 별로 독립 캐시해 직원별 계정이 섞이지 않는다.
    """
    effective_lid = lid or os.getenv("LOTTE_ID")
    effective_lpw = lpw or os.getenv("LOTTE_PW")
    if not effective_lid or not effective_lpw:
        return None, None
    cred_key = hashlib.sha256(f"{effective_lid}:{effective_lpw}".encode()).hexdigest()
    now = time.monotonic()
    session = _lotte_sessions.get(cred_key)
    if session and session.get("cookies") and (now - session.get("at", 0.0)) < LOTTE_COOKIE_TTL:
        return session["cookies"], cred_key
    async with _lotte_lock:
        now = time.monotonic()
        session = _lotte_sessions.get(cred_key)
        if session and session.get("cookies") and (now - session.get("at", 0.0)) < LOTTE_COOKIE_TTL:
            return session["cookies"], cred_key
        try:
            jar = await _do_lotte_login(effective_lid, effective_lpw)
        except Exception:
            jar = None
        _lotte_sessions[cred_key] = {"cookies": jar, "at": time.monotonic()}
        return jar, cred_key


def invalidate_lotte_login(cred_key: Optional[str] = None) -> None:
    """쿠키 만료(로그인 풀림) 감지 시 해당 세션 캐시를 비워 재로그인을 유도."""
    if cred_key and cred_key in _lotte_sessions:
        _lotte_sessions[cred_key]["cookies"] = None
        _lotte_sessions[cred_key]["at"] = 0.0
    elif not cred_key:
        _lotte_sessions.clear()


def fetch_lotte(keyword: str, cookies: Optional[dict] = None, cred_key: Optional[str] = None) -> list[Product]:
    url = LOTTE_SEARCH.format(kw=creq.utils.quote(keyword))
    r = creq.get(url, headers={"User-Agent": UA}, impersonate="chrome",
                 timeout=TIMEOUT, cookies=cookies or None)
    r.raise_for_status()
    # 로그인 쿠키를 줬는데도 비로그인 문구가 보이면 세션 만료/실패 → 다음 호출 재로그인
    if cookies and _LOTTE_LOGIN_MARKER in r.text:
        invalidate_lotte_login(cred_key)
    soup = BeautifulSoup(r.text, "html.parser")
    out: list[Product] = []
    for li in soup.select("ol#unitStyleList > li"):
        a = li.select_one("a.unit_link")
        if not a:
            continue
        name_el = li.select_one(".unit_info .name")
        brand_el = li.select_one(".unit_info .brand")
        if not name_el:
            continue
        name = name_el.get_text(strip=True)
        brand = brand_el.get_text(strip=True) if brand_el else ""
        origin = _num(li.select_one(".unit_price .price01").get_text()) if li.select_one(".unit_price .price01") else None
        sale_el = li.select_one(".unit_price .price02")
        sale = None
        rate = None
        if sale_el:
            rate_el = sale_el.select_one(".sale")
            rate = int(_num(rate_el.get_text())) if rate_el else None
            # 판매가는 .sale 텍스트를 제외한 달러 숫자
            txt = sale_el.get_text(" ", strip=True)
            m = re.search(r"\$[\d,.]+", txt)
            sale = _num(m.group()) if m else None
        krw_el = li.select_one(".unit_price .price03")
        krw = int(_num(krw_el.get_text())) if krw_el and _num(krw_el.get_text()) else None
        prd = a.get("data-prdno") or ""
        opt = ""
        oc = a.get("onclick", "")
        m = re.search(r"ga_adltCheckPrdDtlMove\('(\d+)','(\d+)'", oc)
        if m:
            prd, opt = m.group(1), m.group(2)
        soldout = bool(li.select_one(".soldout, .sold_out")) or "품절" in li.get_text()
        out.append(Product(
            shop="롯데", brand=brand, name=name,
            price_origin=origin, price_sale=sale, discount_rate=rate,
            price_krw=krw, url=LOTTE_DETAIL.format(prd=prd, opt=opt), soldout=soldout,
        ))
    return out


# ---------------------------------------------------------------------------
# 신라인터넷면세점
# ---------------------------------------------------------------------------
SHILLA_SEARCH_PAGE = "https://m.shilladfs.com/estore/kr/ko/search?query={kw}"
SHILLA_AJAX = "https://m.shilladfs.com/estore/kr/ko/ajaxProducts"
SHILLA_DETAIL = "https://m.shilladfs.com/estore/kr/ko/p/{code}"


def fetch_shilla(keyword: str) -> list[Product]:
    sess = creq.Session(impersonate="chrome")
    sess.headers.update({"User-Agent": UA})
    page = sess.get(SHILLA_SEARCH_PAGE.format(kw=creq.utils.quote(keyword)), timeout=TIMEOUT)
    m = re.search(r"CSRFToken['\"\s:=]+([0-9a-f-]{36})", page.text)
    token = m.group(1) if m else ""
    body = {
        "json": json.dumps({
            "category": "", "size": "40", "page": 0,
            "text": keyword, "within": "", "query": keyword,
            "pagination": "", "condition": {"discountRate": "0"},
        }, ensure_ascii=False),
        "CSRFToken": token,
    }
    r = sess.post(SHILLA_AJAX, data=body,
                  headers={"X-Requested-With": "XMLHttpRequest"}, timeout=TIMEOUT)
    r.raise_for_status()
    data = r.json()
    out: list[Product] = []
    for it in data.get("results", []):
        up = it.get("userPrice") or {}
        origin = up.get("salePrice")
        # 마일리지(S리워즈) 선차감 할인이 적용되면 그 가격/율 우선 사용
        if up.get("mileageDcApplyYn") and up.get("mileageDcPrice") is not None:
            sale = up.get("mileageDcPrice")
            rate = up.get("mileageDcRate")
        else:
            sale = it.get("discountPrice") if it.get("discountPrice") is not None else up.get("discountPrice")
            rate = it.get("discountRate")
        code = it.get("code")
        soldout = (it.get("stockAvailable") or 0) <= 0
        out.append(Product(
            shop="신라",
            brand=it.get("brandName") or (it.get("brandCategory") or {}).get("brandName", ""),
            name=it.get("productNameForDisp") or it.get("name") or "",
            price_origin=float(origin) if origin is not None else None,
            price_sale=float(sale) if sale is not None else None,
            discount_rate=int(round(rate)) if rate is not None else None,
            price_krw=None,
            url=SHILLA_DETAIL.format(code=code),
            soldout=soldout,
        ))
    return out


def fetch_shilla_by_sku(sku: str) -> tuple[Product | None, dict]:
    """SKU 번호로 신라 상품 정확 조회 (skuNo 완전 일치).

    Returns: (Product | None, meta) where meta =
      {ref_no, brand_kr, brand_en, category, product_name}
    신라에서 상품 확정 후 ref_no 를 롯데·신세계 검색 키워드로 사용한다.
    """
    sess = creq.Session(impersonate="chrome")
    sess.headers.update({"User-Agent": UA})
    page = sess.get(SHILLA_SEARCH_PAGE.format(kw=creq.utils.quote(sku)), timeout=TIMEOUT)
    m = re.search(r"CSRFToken['\"\s:=]+([0-9a-f-]{36})", page.text)
    token = m.group(1) if m else ""
    body = {
        "json": json.dumps({
            "category": "", "size": "10", "page": 0,
            "text": sku, "within": "", "query": sku,
            "pagination": "", "condition": {"discountRate": "0"},
        }, ensure_ascii=False),
        "CSRFToken": token,
    }
    r = sess.post(SHILLA_AJAX, data=body,
                  headers={"X-Requested-With": "XMLHttpRequest"}, timeout=TIMEOUT)
    r.raise_for_status()
    results = r.json().get("results", [])

    hit = next((it for it in results if it.get("skuNo") == sku), None)
    if not hit:
        return None, {}

    code = hit.get("code", "")
    brand_cat = hit.get("brandCategory") or {}
    brand_kr = (hit.get("brandName") or brand_cat.get("brandName") or "").strip()
    brand_en = (brand_cat.get("enName") or "").strip()
    product_name = (hit.get("productNameForDisp") or hit.get("name") or "").strip()
    ref_no = (hit.get("refNo") or "").strip()
    category = ""

    # 상세 페이지에서 영문 브랜드명·카테고리 보완 (sku_lookup과 동일 로직)
    if code:
        try:
            dr = sess.get(SHILLA_DETAIL.format(code=code), timeout=TIMEOUT)
            soup = BeautifulSoup(dr.text, "html.parser")
            if not brand_en:
                info_brand = soup.select_one("strong.info_brand")
                if info_brand:
                    ib_text = info_brand.get_text(strip=True)
                    if " | " in ib_text:
                        brand_kr, brand_en = [b.strip() for b in ib_text.split(" | ", 1)]
            bc_items = soup.select("ul.breadcrumb_box li.on")
            if bc_items:
                category = bc_items[-1].get_text(strip=True)
        except Exception:
            pass

    up = hit.get("userPrice") or {}
    origin = up.get("salePrice")
    # 마일리지(S리워즈) 선차감 할인이 적용되면 그 가격/율 우선 사용
    if up.get("mileageDcApplyYn") and up.get("mileageDcPrice") is not None:
        sale = up.get("mileageDcPrice")
        rate = up.get("mileageDcRate")
    else:
        sale = hit.get("discountPrice") if hit.get("discountPrice") is not None else up.get("discountPrice")
        rate = hit.get("discountRate")
    soldout = (hit.get("stockAvailable") or 0) <= 0

    product = Product(
        shop="신라",
        brand=brand_kr,
        name=product_name,
        price_origin=float(origin) if origin is not None else None,
        price_sale=float(sale) if sale is not None else None,
        discount_rate=int(round(rate)) if rate is not None else None,
        price_krw=None,
        url=SHILLA_DETAIL.format(code=code),
        soldout=soldout,
    )
    return product, {
        "ref_no": ref_no,
        "brand_kr": brand_kr,
        "brand_en": brand_en,
        "category": category,
        "product_name": product_name,
    }


# ---------------------------------------------------------------------------
# 신세계인터넷면세점 (Playwright 컨텍스트 내에서 직접 탐색)
#   FECAS WAF 쿠키가 발급한 브라우저의 TLS 지문에 묶여 있어 curl 재사용이 불가.
#   → Playwright 브라우저 컨텍스트를 캐시해 두고 그 안에서 검색 페이지를 연다.
# ---------------------------------------------------------------------------
SSG_HOME = "https://www.ssgdfs.com/kr/main/initMain"
SSG_LOGIN = "https://www.ssgdfs.com/kr/login/login"
SSG_SEARCH = "https://www.ssgdfs.com/kr/search/resultsTotal?startCount=0&query={kw}"
SSG_DETAIL = "https://www.ssgdfs.com/kr/goos/initDetailGoos?goos_cd={cd}"

_SSG_EXTRACT_JS = r"""
() => {
  const out = [];
  document.querySelectorAll('li.prodCont').forEach(li => {
    const t = s => { const e = li.querySelector(s); return e ? e.textContent.trim() : ''; };
    const name = t('.prodName');
    if (!name) return;
    let cd = '';
    const a = li.querySelector("a[onclick*='goDetail']");
    if (a) { const m = (a.getAttribute('onclick')||'').match(/goos_cd\s*:\s*'(\d+)'/); if (m) cd = m[1]; }
    out.push({
      brand: t('.brandName'),
      name,
      origin: t('.originPrice'),
      sale: t('.saleDollar'),
      cd,
      soldout: !!li.querySelector('.soldOut') || li.textContent.includes('품절'),
    });
  });
  return out;
}
"""


class _SsgBrowser:
    """WAF를 통과한 Playwright 컨텍스트를 재사용한다."""

    def __init__(self):
        self._pw = None
        self._browser = None
        self._ctx = None
        self._lock = asyncio.Lock()
        self._logged_in = False  # 회원 로그인 1회 수행 여부

    async def _ensure(self):
        from playwright.async_api import async_playwright
        if self._ctx is not None:
            return
        self._pw = await async_playwright().start()
        self._browser = await self._pw.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",                # 컨테이너 root 실행 대응
                "--disable-dev-shm-usage",     # 작은 /dev/shm 에서 크래시 방지
                "--disable-gpu",
            ])
        self._ctx = await self._browser.new_context(
            user_agent=UA, locale="ko-KR", viewport={"width": 1366, "height": 900})
        await self._ctx.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});")

    async def _reset(self):
        for closer in (
            lambda: self._ctx and self._ctx.close(),
            lambda: self._browser and self._browser.close(),
            lambda: self._pw and self._pw.stop(),
        ):
            try:
                res = closer()
                if res:
                    await res
            except Exception:
                pass
        self._pw = self._browser = self._ctx = None
        self._logged_in = False

    async def _ensure_login(self, sid: Optional[str] = None, spw: Optional[str] = None) -> None:
        """WAF 통과 컨텍스트에서 회원 로그인 1회 수행(쿠키는 컨텍스트에 유지).

        비번이 클라이언트(KISA) 암호화라 레이어 로그인 폼을 직접 채워 제출한다.
        자격증명 없거나 실패해도 1회만 시도하고 비로그인으로 검색을 진행한다.
        """
        if self._logged_in:
            return
        effective_sid = sid or os.getenv("SSG_ID")
        effective_spw = spw or os.getenv("SSG_PW")
        if not effective_sid or not effective_spw:
            self._logged_in = True
            return
        page = await self._ctx.new_page()
        try:
            # 홈을 먼저 열어 WAF 쿠키 확보 후 로그인 페이지로 이동(직접 진입은 WAF 차단)
            await page.goto(SSG_HOME, wait_until="domcontentloaded", timeout=30000)
            await page.goto(SSG_LOGIN, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(800)
            await page.evaluate(
                "() => document.querySelectorAll('[class*=notiPop],.dimmed').forEach(e=>e.remove())")
            await page.wait_for_selector("#login_id", timeout=8000)
            # 반드시 "신세계면세점 회원" 탭(loginTab02)에서 로그인(통합회원 아님)
            await page.click("#loginTab02")
            await page.wait_for_timeout(400)
            # 로그인 실패 누적 시 캡차가 요구됨 → 자동 로그인 불가, 시도 중단(잠금 방지)
            captcha = await page.evaluate(
                "() => (document.getElementById('captchaTypeCd')||{}).value || ''")
            if not captcha:
                await page.fill("#login_id", effective_sid)
                await page.fill("#pwd", effective_spw)
                # 제출 버튼(loginTryCheck가 KISA 암호화+AJAX 로그인 수행)
                await page.click("#loginSubmitBtn")
                await page.wait_for_timeout(3500)
        except Exception:
            pass
        finally:
            await page.close()
            self._logged_in = True  # 성공/실패 무관 1회만 시도(매 검색 재시도·캡차 잠금 방지)

    async def search(self, keyword: str, sid: Optional[str] = None, spw: Optional[str] = None) -> list[Product]:
        # WAF가 직접 URL 진입을 차단하므로, 홈에서 검색 폼을 submit 해 결과로 이동한다.
        safe_kw = keyword.replace("\\", " ").replace("'", " ").strip()
        async with self._lock:
            for attempt in range(2):
                try:
                    await self._ensure()
                    await self._ensure_login(sid, spw)  # 최초 1회 회원 로그인
                    page = await self._ctx.new_page()
                    try:
                        await page.goto(SSG_HOME, wait_until="domcontentloaded", timeout=30000)
                        async with page.expect_navigation(
                                wait_until="domcontentloaded", timeout=30000):
                            await page.evaluate(
                                "(kw)=>{document.getElementById('totalSearch').value=kw;"
                                "document.getElementById('search').submit();}", safe_kw)
                        try:
                            await page.wait_for_selector("li.prodCont", timeout=8000)
                        except Exception:
                            pass  # 검색 결과 0건일 수도 있음
                        rows = await page.evaluate(_SSG_EXTRACT_JS)
                    finally:
                        await page.close()
                    return [self._row_to_product(r) for r in rows]
                except Exception:
                    await self._reset()
            return []

    @staticmethod
    def _row_to_product(r: dict) -> Product:
        origin = _num(r.get("origin"))
        sale = _num(r.get("sale"))
        rate = int(round((origin - sale) / origin * 100)) if origin and sale and origin > 0 else None
        return Product(
            shop="신세계", brand=r.get("brand", ""), name=r.get("name", ""),
            price_origin=origin, price_sale=sale, discount_rate=rate,
            price_krw=None, url=SSG_DETAIL.format(cd=r.get("cd", "")),
            soldout=bool(r.get("soldout")),
        )


_ssg_browser = _SsgBrowser()


async def fetch_ssg_async(keyword: str, sid: Optional[str] = None, spw: Optional[str] = None) -> list[Product]:
    return await _ssg_browser.search(keyword, sid, spw)


def fetch_ssg(keyword: str) -> list[Product]:
    """동기 컨텍스트용 래퍼(테스트/CLI)."""
    return asyncio.run(_ssg_browser.search(keyword))
