"""Smart Duty Free — 인터넷면세점 3사 가격 비교 웹앱.

브랜드명 + 상품명을 입력하면 신라·롯데·신세계 인터넷면세점에서
동일 상품의 할인율과 가격을 찾아 비교 표로 보여준다.
"""

from __future__ import annotations

import asyncio
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, Query
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

from . import clients

BASE_DIR = Path(__file__).parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

DEFAULT_RATE = 1500.0  # 환율 미확보 시 KRW 환산 추정용 기본값

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

    상품명에서 가장 긴 영숫자 토큰(모델코드, 예: VVCC25)을 우선 사용한다.
    색상코드(BR 등)만 단독으로 쓰면 결과가 과도하므로 모델코드를 쓴다.
    """
    tokens = re.findall(r"[A-Za-z0-9]+", product or "")
    tokens = [t for t in tokens if len(t) >= 3]
    if tokens:
        return max(tokens, key=len)
    if (product or "").strip():
        return product.strip()
    return (brand or "").strip()


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

    # 롯데/신라는 동기(curl_cffi) → 스레드, 신세계는 async(Playwright)
    lotte_t = asyncio.to_thread(clients.fetch_lotte, keyword)
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


@app.get("/")
async def index(request: Request):
    return templates.TemplateResponse(request, "index.html")


@app.get("/healthz")
async def healthz():
    return {"ok": True}
