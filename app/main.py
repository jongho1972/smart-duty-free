"""Smart Duty Free — 인터넷면세점 3사 가격 비교 웹앱.

브랜드명 + 상품명을 입력하면 신라·롯데·신세계 인터넷면세점에서
동일 상품의 할인율과 가격을 찾아 비교 표로 보여준다.
"""

from __future__ import annotations

import asyncio
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, Query
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

from . import clients

BASE_DIR = Path(__file__).parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


def _load_dotenv() -> None:
    """smart_duty_free/.env 가 있으면 환경변수로 로드(이미 설정된 값은 보존).

    VPS에서는 docker 환경변수가 우선하고, 로컬 개발에서는 .env 를 쓴다.
    """
    env_path = BASE_DIR.parent / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        os.environ.setdefault(key.strip(), val.strip())


_load_dotenv()

DEFAULT_RATE = 1500.0  # 환율 미확보 시 KRW 환산 추정용 기본값


def _asset_version() -> str:
    """정적 자산(js/css)의 최신 mtime → 캐시버스팅 버전.

    배포 시 git checkout으로 파일 mtime이 갱신되므로 버전이 바뀌어
    브라우저가 이전 app.js/style.css를 캐시로 재사용하는 문제를 막는다.
    """
    latest = 0
    for p in (BASE_DIR / "static").glob("*"):
        try:
            latest = max(latest, int(p.stat().st_mtime))
        except OSError:
            pass
    return str(latest)


ASSET_VERSION = _asset_version()

# --- 비밀번호 게이트 (신라면세점 서브페이지와 동일 비번 0708) ---
GATE_PASSWORD = "0708"
AUTH_COOKIE = "sdf_auth"
AUTH_TOKEN = "ok-0708"          # 인증 통과 표식(개인 도구 수준)
AUTH_MAX_AGE = 60 * 60 * 12     # 12시간


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    # 종료 시 Playwright 리소스 정리
    try:
        await clients._ssg_browser._reset()
    except Exception:
        pass


app = FastAPI(title="Smart Duty Free", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


def choose_keyword(brand: str, product: str) -> str:
    """검색에 가장 효과적인 키워드 선택.

    1순위: 상품명의 모델코드(숫자를 포함한 영숫자 4자+, 예 VVCC25/0RB3447001).
           면세점이 그 모델을 보유하면 정확히 좁혀지고, 미보유면 best_match가 거른다.
    2순위: 모델코드가 없으면 상품명의 가장 긴 토큰(GUSSETED·CRESCENT 등 고유 단어).
           브랜드명보다 고유 단어로 검색해야 원하는 상품이 결과에 직접 들어온다.
           무관 브랜드가 섞여도 best_match가 브랜드 불일치로 거른다.
    3순위: 상품 토큰이 없으면 브랜드명.
    """
    tokens = re.findall(r"[A-Za-z0-9]+", product or "")
    models = [t for t in tokens if len(t) >= 4 and any(c.isdigit() for c in t)]
    if models:
        return max(models, key=len)
    longish = [t for t in tokens if len(t) >= 3]
    if longish:
        return max(longish, key=len)
    return clients._clean_brand(brand) or (product or "").strip() or (brand or "").strip()


def _result_block(shop: str, p) -> dict:
    if p is None:
        return {"shop": shop, "found": False}
    d = p.to_dict()
    d["found"] = True
    return d


async def compare(brand: str, product: str) -> dict:
    keyword = choose_keyword(brand, product)
    if not keyword:
        return {"error": "브랜드명 또는 상품명을 입력해 주세요."}

    # 롯데 회원가/할인율은 로그인해야 노출 → 세션 쿠키 확보(자격증명 없으면 None)
    lotte_cookies = await clients.ensure_lotte_login()

    # 롯데/신라는 동기(curl_cffi) → 스레드, 신세계는 async(Playwright)
    lotte_t = asyncio.to_thread(clients.fetch_lotte, keyword, lotte_cookies)
    shilla_t = asyncio.to_thread(clients.fetch_shilla, keyword)
    ssg_t = clients.fetch_ssg_async(keyword)
    lotte_r, shilla_r, ssg_r = await asyncio.gather(
        lotte_t, shilla_t, ssg_t, return_exceptions=True)

    def pick(res):
        if isinstance(res, Exception) or not res:
            return None
        return clients.best_match(res, brand, product, keyword)

    lotte = pick(lotte_r)
    shilla = pick(shilla_r)
    ssg = pick(ssg_r)

    # 환율: 롯데가 제공하는 정확한 KRW로 추정(없으면 기본값)
    rate = DEFAULT_RATE
    if lotte and lotte.price_krw and lotte.price_sale:
        rate = lotte.price_krw / lotte.price_sale

    # 신라·신세계 KRW 환산(추정)
    for p in (shilla, ssg):
        if p and p.price_krw is None and p.price_sale is not None:
            p.price_krw = int(round(p.price_sale * rate))
            p.krw_estimated = True  # type: ignore[attr-defined]

    shops = {
        "신라": _result_block("신라", shilla),
        "롯데": _result_block("롯데", lotte),
        "신세계": _result_block("신세계", ssg),
    }
    # krw_estimated 플래그 반영
    for key, p in (("신라", shilla), ("신세계", ssg)):
        if p is not None:
            shops[key]["krw_estimated"] = getattr(p, "krw_estimated", False)

    errors = {
        "신라": isinstance(shilla_r, Exception),
        "롯데": isinstance(lotte_r, Exception),
        "신세계": isinstance(ssg_r, Exception),
    }

    return {
        "query": {"brand": brand, "product": product, "keyword": keyword},
        "shops": shops,
        "errors": errors,
        "exchange_rate": round(rate, 2),
    }


@app.post("/api/verify")
async def api_verify(payload: dict = Body(default={})):
    """비밀번호 확인 → 통과 시 인증 쿠키 설정."""
    if (payload or {}).get("password") == GATE_PASSWORD:
        resp = JSONResponse({"ok": True})
        resp.set_cookie(
            AUTH_COOKIE, AUTH_TOKEN, max_age=AUTH_MAX_AGE,
            httponly=True, samesite="lax", secure=True, path="/")
        return resp
    return JSONResponse({"ok": False}, status_code=401)


@app.get("/api/compare")
async def api_compare(
    request: Request,
    brand: str = Query("", description="브랜드명"),
    product: str = Query("", description="상품명/모델"),
):
    if request.cookies.get(AUTH_COOKIE) != AUTH_TOKEN:
        return JSONResponse({"error": "auth_required"}, status_code=401)
    return JSONResponse(await compare(brand.strip(), product.strip()))


EXPORT_HEADERS = [
    "상품명", "브랜드명", "면세가",
    "신라 할인률", "롯데 할인률", "신세계 할인률",
    "신라 링크", "롯데 링크", "신세계 링크",
]
EXPORT_SHOPS = ["신라", "롯데", "신세계"]


@app.post("/api/export")
async def api_export(request: Request, payload: dict = Body(default={})):
    """결과를 .xlsx로 생성. 웹 표와 동일하게 할인률과 '가격확인 링크'를
    별도 컬럼으로 구분한다(엑셀은 셀당 하이퍼링크 1개 제약 → 면세점별 링크 컬럼)."""
    if request.cookies.get(AUTH_COOKIE) != AUTH_TOKEN:
        return JSONResponse({"error": "auth_required"}, status_code=401)

    from io import BytesIO
    from openpyxl import Workbook
    from openpyxl.styles import Font

    rows = (payload or {}).get("rows") or []
    wb = Workbook()
    ws = wb.active
    ws.title = "가격비교"
    ws.append(EXPORT_HEADERS)
    head_font = Font(bold=True, color="0B2E5C")
    for c in ws[1]:
        c.font = head_font
    link_font = Font(color="1F6FEB", underline="single")

    for r in rows:
        shops = (r or {}).get("shops") or {}
        ws.append([r.get("product", ""), r.get("brand", ""), r.get("face", ""),
                   "", "", "", "", "", ""])
        rownum = ws.max_row
        for i, s in enumerate(EXPORT_SHOPS):
            sh = shops.get(s) or {}
            # 할인률(숫자만, 링크 없음)
            rate_cell = ws.cell(row=rownum, column=4 + i)
            rate_cell.value = sh.get("rate") or "—"
            # 가격확인 링크(별도 컬럼) — '바로가기' 텍스트에 하이퍼링크
            link_cell = ws.cell(row=rownum, column=7 + i)
            url = sh.get("url")
            if url:
                link_cell.value = "바로가기"
                link_cell.hyperlink = url
                link_cell.font = link_font
            else:
                link_cell.value = "—"

    for col, width in zip("ABCDEFGHI", (30, 20, 10, 11, 11, 11, 11, 11, 11)):
        ws.column_dimensions[col].width = width
    ws.freeze_panes = "A2"

    buf = BytesIO()
    wb.save(buf)
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="price_compare.xlsx"'},
    )


@app.get("/")
async def index(request: Request):
    return templates.TemplateResponse(
        request, "index.html", {"v": ASSET_VERSION})


@app.get("/healthz")
async def healthz():
    return {"ok": True}
