# CLAUDE.md — Smart Duty Free (면세점 가격 비교)

## 개요

브랜드명 + 상품명을 입력하면 **신라·롯데·신세계 인터넷면세점**에서 동일 상품의
할인율·가격을 조회해 비교 표로 보여주는 FastAPI 웹앱.

- 입력: 브랜드명(예: `Vedi Vero` 또는 `베디베로`), 상품명/모델(예: `VVCC25 / BR`)
- 출력: 면세점별 정가·할인율·판매가($)·판매가(원)·상품 링크 비교표 (최저가 강조, 품절 표시)

## 실행

```bash
cd smart_duty_free
pip install -r requirements.txt
python -m playwright install chromium      # 최초 1회 (신세계 조회용)
python -m uvicorn app.main:app --reload --port 8077
# http://127.0.0.1:8077
```

## 구조

| 파일 | 역할 |
|------|------|
| `app/main.py` | FastAPI 서버, `/api/compare?brand=&product=`, 3사 동시 조회·KRW 환산·정적 자산 캐시버스팅(`?v=mtime`) |
| `app/clients.py` | 3사 조회 클라이언트 + 상품 매칭 로직 |
| `app/templates/index.html` | 단일 페이지 UI (일괄 입력 textarea, 기본값 프리셋) |
| `app/static/style.css` | 항공편수·출국객수 대시보드와 동일 톤(네이비 `#0B2E5C` + 슬레이트 + Pretendard, footnote 푸터) |
| `app/static/app.js` | 일괄 입력 파싱 → 순차 조회 → 상품별 1행 표 렌더 + CSV 다운로드 |

### UI 동작 (공기관 제출용 심플 양식)
- **일괄 비교 전용**: 한 줄=`상품명〈Tab〉브랜드명`, 순차 조회(신세계 Playwright 탓 건당 6~8초), 최대 20건, 진행표시는 "전체 비교" 버튼 옆
- **결과 표**: `상품명·브랜드명·면세가·신라/롯데/신세계 할인률·가격확인 링크` 7컬럼. 상품명·브랜드명은 입력값 그대로(줄바꿈 없음), 뱃지 없음
- **CSV 다운로드**: 결과를 UTF-8 BOM csv로 (`면세점_가격비교_YYYYMMDD.csv`)

## 사이트별 조회 방식 (중요)

3사의 접근 난이도가 모두 다르다. 사이트 구조 변경 시 아래를 기준으로 디버깅한다.

| 면세점 | 방식 | 핵심 |
|--------|------|------|
| **롯데** | 순수 HTTP GET (`curl_cffi`) | 검색 결과가 **서버 렌더링 HTML**. `kor.lottedfs.com/kr/search?comSearchWord=` → `ol#unitStyleList > li` 파싱. 상품 링크는 `onclick`의 `ga_adltCheckPrdDtlMove(prdNo,prdOptNo)`로 구성 |
| **신라** | HTTP POST (`curl_cffi`) | `ajaxProducts`가 **JSON API**. 검색 페이지 GET으로 `CSRFToken`+쿠키 획득 후 POST. `userPrice.salePrice`(정가)/`discountPrice`(판매가)/`discountRate`, `code`로 링크 |
| **신세계** | **Playwright 헤드리스** | WAF(`FECAS` httpOnly 쿠키)가 일반 HTTP를 **406/403 차단**. 쿠키는 발급 브라우저 TLS 지문에 묶여 재사용 불가. **직접 URL 진입도 차단**되므로, 홈(`/kr/main/initMain`)에서 검색 폼(`#search`)을 `submit()`해 결과로 이동해야 통과. 브라우저 컨텍스트는 캐시 재사용 |

### 신세계 주의사항
- 헤드리스 탐지 회피: `--disable-blink-features=AutomationControlled` + `navigator.webdriver` 마스킹 필수.
- 직접 `goto(resultsTotal?query=...)` 는 403("연결 문제") → 반드시 폼 submit 경유.
- 첫 조회는 브라우저 기동 때문에 수 초 소요, 이후 컨텍스트 재사용으로 빨라짐.

## 상품 매칭 로직 (`clients.best_match`)

면세점마다 같은 모델의 표기가 다르다(신라·롯데 `파도바`, 신세계 `VVCC25`). 그래서:

- 검색 키워드는 상품명에서 **가장 긴 영숫자 토큰(모델코드, 예 `VVCC25`)** 을 사용(`main.choose_keyword`).
- 키워드가 **모델코드(영숫자 4자+)** 면 검색 결과가 이미 동일 모델군으로 좁혀진 것으로 보고, 색상 등 상품 토큰 일치로 **변형만 선택**(롯데는 상품명에 모델코드가 없어 이 신뢰가 필요).
- 키워드가 **한글 별칭** 등 약한 경우엔 브랜드 일치/강한 토큰/2개 이상 토큰 일치를 요구해 **타 카테고리 오매칭 차단**(예: "피렌체" 검색 시 신세계 목베개 오매칭 방지).
- `_norm`은 영문·숫자·**한글**만 남긴다(한글 상품명 매칭 필수).

## KRW 환산

- 롯데는 사이트가 정확한 원화를 제공 → 그대로 사용.
- 신라·신세계는 달러 판매가만 → 롯데가 제공한 환율로 환산(추정, UI에 `≈` 표기).

## 배포 메모 (미배포)

- VPS 배포 시 Playwright Chromium(ARM) 설치 필요(`playwright install chromium --with-deps`). 컨테이너 이미지가 커지므로(`mcr.microsoft.com/playwright` 베이스 권장) 신세계 조회 비중을 고려해 결정.
- 외부 사이트 구조에 의존하므로 셀렉터/엔드포인트 변경 시 깨질 수 있음 → 파서는 사이트별로 격리되어 한 곳이 실패해도 나머지는 표시됨(`errors` 필드).
