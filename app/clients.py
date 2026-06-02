"""인터넷면세점 3사(신라·롯데·신세계) 가격 조회 클라이언트.

각 사이트의 접근 방식이 다르다.
- 롯데: 검색 결과가 서버 렌더링(HTML) → curl_cffi GET 후 BeautifulSoup 파싱.
- 신라: ajaxProducts 가 JSON API → 검색 페이지에서 CSRF 토큰/쿠키 획득 후 POST.
- 신세계: WAF(FECAS httpOnly 쿠키)가 일반 HTTP를 406 차단 → Playwright로 쿠키를
          수확해 캐시하고 curl_cffi 로 재사용(만료 시 자동 재수확).
"""

from __future__ import annotations

import asyncio
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


def _evaluate(brand_tokens, prod_tokens, text) -> tuple[bool, int]:
    """후보 텍스트에 대한 (유효여부, 점수) 계산.

    면세점마다 상품명 표기(모델코드 vs 한글 별칭)가 달라 오매칭이 생기므로,
    아래 중 하나를 만족해야 '유효'한 매칭으로 본다.
      · 브랜드 토큰이 하나라도 일치, 또는
      · 강한 상품 토큰(모델코드 등 4자 이상)이 일치, 또는
      · 상품 토큰이 2개 이상 일치
    """
    nt = _norm(text)
    b = sum(1 for t in brand_tokens if t in nt)
    pm = [t for t in prod_tokens if t in nt]
    strong = any(len(t) >= 4 for t in pm)
    valid = (b > 0) or strong or (len(pm) >= 2)
    score = b + 2 * len(pm) + (3 if strong else 0)
    return valid, score


def best_match(products: list[Product], brand: str, product: str,
               keyword: str = "") -> Optional[Product]:
    """브랜드+상품 기준으로 가장 잘 맞는 상품 1개 선택(오매칭 방지).

    keyword 가 모델코드(영숫자 4자+)이면 검색 결과가 이미 동일 모델군으로
    좁혀진 것으로 보고, 색상 등 상품 토큰 일치로 변형만 고른다(롯데처럼
    상품명에 모델코드가 안 들어가는 경우 대응). 그 외(한글 별칭 등)에는
    엄격 검증으로 타 카테고리 오매칭을 막는다.
    """
    if not products:
        return None
    bt, pt = _tokens(brand), _tokens(product)
    kw_is_model = bool(re.fullmatch(r"[A-Za-z0-9]{4,}", keyword or ""))

    scored = []
    for p in products:
        text = f"{p.brand} {p.name}"
        nt = _norm(text)
        b = sum(1 for t in bt if t in nt)
        pm = [t for t in pt if t in nt]
        strong = any(len(t) >= 4 for t in pm)
        if kw_is_model:
            valid = True  # 검색이 모델군으로 이미 좁힘 → 변형만 고른다
        else:
            valid = (b > 0) or strong or (len(pm) >= 2)
        score = b + 2 * len(pm) + (3 if strong else 0)
        scored.append((valid, score, not p.soldout, p))

    scored.sort(key=lambda x: (x[0], x[1], x[2]), reverse=True)
    valid, score, _, top = scored[0]
    if not valid:
        return None
    # 모델코드 검색은 결과를 신뢰하므로 점수 0이어도 첫 변형 채택
    if not kw_is_model and score == 0:
        return None
    return top


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

_lotte_cookies: Optional[dict] = None
_lotte_cookies_at: float = 0.0
_lotte_lock = asyncio.Lock()


async def _do_lotte_login() -> Optional[dict]:
    """L.POINT 로그인 후 lottedfs.com 세션 쿠키 수확.

    메모리 절약을 위해 신세계용 Chromium(_ssg_browser)을 공유하고, 로그인은
    격리된 새 컨텍스트에서 수행한 뒤 컨텍스트만 닫는다(별도 프로세스 미기동).
    """
    lid, lpw = os.getenv("LOTTE_ID"), os.getenv("LOTTE_PW")
    if not lid or not lpw:
        return None
    await _ssg_browser._ensure()  # 공유 Chromium 보장
    ctx = await _ssg_browser._browser.new_context(
        user_agent=UA, locale="ko-KR", viewport={"width": 1366, "height": 900})
    try:
        await ctx.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});")
        page = await ctx.new_page()
        await page.goto(LOTTE_LOGIN_URL, wait_until="domcontentloaded", timeout=30000)
        await page.fill("#loginLpId", lid)
        await page.fill("#password", lpw)
        try:
            async with page.expect_navigation(wait_until="domcontentloaded", timeout=15000):
                await page.evaluate("() => doLpointLogin('N')")
        except Exception:
            await page.wait_for_timeout(3000)  # 페이지 내 처리(비이동)일 수 있음
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


async def ensure_lotte_login() -> Optional[dict]:
    """유효한 롯데 세션 쿠키를 반환(필요 시 로그인). 자격증명 없으면 None."""
    global _lotte_cookies, _lotte_cookies_at
    if not os.getenv("LOTTE_ID") or not os.getenv("LOTTE_PW"):
        return None
    now = time.monotonic()
    if _lotte_cookies and (now - _lotte_cookies_at) < LOTTE_COOKIE_TTL:
        return _lotte_cookies
    async with _lotte_lock:
        now = time.monotonic()
        if _lotte_cookies and (now - _lotte_cookies_at) < LOTTE_COOKIE_TTL:
            return _lotte_cookies
        try:
            jar = await _do_lotte_login()
        except Exception:
            jar = None
        if jar:
            _lotte_cookies, _lotte_cookies_at = jar, time.monotonic()
        return _lotte_cookies


def invalidate_lotte_login() -> None:
    """쿠키 만료(로그인 풀림) 감지 시 다음 호출에서 재로그인하도록 캐시 비움."""
    global _lotte_cookies, _lotte_cookies_at
    _lotte_cookies, _lotte_cookies_at = None, 0.0


def fetch_lotte(keyword: str, cookies: Optional[dict] = None) -> list[Product]:
    url = LOTTE_SEARCH.format(kw=creq.utils.quote(keyword))
    r = creq.get(url, headers={"User-Agent": UA}, impersonate="chrome",
                 timeout=TIMEOUT, cookies=cookies or None)
    r.raise_for_status()
    # 로그인 쿠키를 줬는데도 비로그인 문구가 보이면 세션 만료/실패 → 다음 호출 재로그인
    if cookies and _LOTTE_LOGIN_MARKER in r.text:
        invalidate_lotte_login()
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

    async def _ensure_login(self) -> None:
        """WAF 통과 컨텍스트에서 회원 로그인 1회 수행(쿠키는 컨텍스트에 유지).

        비번이 클라이언트(KISA) 암호화라 레이어 로그인 폼을 직접 채워 제출한다.
        자격증명 없거나 실패해도 1회만 시도하고 비로그인으로 검색을 진행한다.
        """
        if self._logged_in:
            return
        sid, spw = os.getenv("SSG_ID"), os.getenv("SSG_PW")
        if not sid or not spw:
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
                await page.fill("#login_id", sid)
                await page.fill("#pwd", spw)
                # 제출 버튼(loginTryCheck가 KISA 암호화+AJAX 로그인 수행)
                await page.click("#loginSubmitBtn")
                await page.wait_for_timeout(3500)
        except Exception:
            pass
        finally:
            await page.close()
            self._logged_in = True  # 성공/실패 무관 1회만 시도(매 검색 재시도·캡차 잠금 방지)

    async def search(self, keyword: str) -> list[Product]:
        # WAF가 직접 URL 진입을 차단하므로, 홈에서 검색 폼을 submit 해 결과로 이동한다.
        safe_kw = keyword.replace("\\", " ").replace("'", " ").strip()
        async with self._lock:
            for attempt in range(2):
                try:
                    await self._ensure()
                    await self._ensure_login()  # 최초 1회 회원 로그인
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


async def fetch_ssg_async(keyword: str) -> list[Product]:
    return await _ssg_browser.search(keyword)


def fetch_ssg(keyword: str) -> list[Product]:
    """동기 컨텍스트용 래퍼(테스트/CLI)."""
    return asyncio.run(_ssg_browser.search(keyword))
