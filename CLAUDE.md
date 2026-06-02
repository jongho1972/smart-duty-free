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
| `app/static/app.js` | 일괄 입력 파싱 → 순차 조회 → 상품별 1행 표 렌더 + 엑셀(.xlsx) 다운로드 |

### UI 동작 (공기관 제출용 심플 양식)
- **일괄 비교 전용**: 한 줄=`상품명〈Tab〉브랜드명`, 순차 조회(신세계 Playwright 탓 건당 6~8초), 최대 20건, 진행표시는 "전체 비교" 버튼 옆
- **결과 표**: `상품명·브랜드명·면세가·신라/롯데/신세계 할인률·가격확인 링크` 7컬럼. 상품명·브랜드명은 입력값 그대로(줄바꿈 없음), 뱃지 없음
- **엑셀(.xlsx) 다운로드**: 서버(`/api/export`, openpyxl)에서 생성. 헤더 9컬럼 = `상품명·브랜드명·면세가·신라/롯데/신세계 할인률·신라/롯데/신세계 링크`. 웹 표처럼 **할인률(숫자만)과 '가격확인 링크'를 분리**(엑셀은 셀당 하이퍼링크 1개 제약 → 면세점별 링크 컬럼에 '바로가기'+하이퍼링크, 결측 시 `—`)

## 사이트별 조회 방식 (중요)

3사의 접근 난이도가 모두 다르다. 사이트 구조 변경 시 아래를 기준으로 디버깅한다.

| 면세점 | 방식 | 핵심 |
|--------|------|------|
| **롯데** | **L.POINT 로그인(Playwright)** + HTTP GET (`curl_cffi`) | 검색 결과가 **서버 렌더링 HTML**. `kor.lottedfs.com/kr/search?comSearchWord=` → `ol#unitStyleList > li` 파싱. 상품 링크는 `onclick`의 `ga_adltCheckPrdDtlMove(prdNo,prdOptNo)`로 구성. **회원가/할인율은 로그인해야 노출**(비로그인은 "로그인 후 할인율 확인"+정가만) |

### 롯데 로그인 (회원가 수집)
- 비밀번호 클라이언트 암호화(KISA)로 raw HTTP 로그인 복제 불가 → **Playwright로 L.POINT 로그인**(`kor.lps.lottedfs.com/kr/member/login`, `#loginLpId`+`#password`→`doLpointLogin('N')`) 후 `lottedfs.com` 세션 쿠키 수확해 `fetch_lotte`의 `curl_cffi`에 재사용(30분 캐시, `ensure_lotte_login`).
- **신세계용 Chromium(`_ssg_browser`) 공유** — 새 컨텍스트만 열어 로그인(메모리 900m 가드 내). 캡차 없음.
- 자격증명은 **환경변수 `LOTTE_ID`/`LOTTE_PW`**: 로컬은 `.env`(gitignore), VPS는 `deploy/.env.dfprice`(docker `env_file`). 미설정 시 비로그인으로 graceful fallback.
| **신라** | HTTP POST (`curl_cffi`) | `ajaxProducts`가 **JSON API**. 검색 페이지 GET으로 `CSRFToken`+쿠키 획득 후 POST. `userPrice.salePrice`(정가)/`discountPrice`(판매가)/`discountRate`, `code`로 링크 |
| **신세계** | **Playwright 헤드리스** | WAF(`FECAS` httpOnly 쿠키)가 일반 HTTP를 **406/403 차단**. 쿠키는 발급 브라우저 TLS 지문에 묶여 재사용 불가. **직접 URL 진입도 차단**되므로, 홈(`/kr/main/initMain`)에서 검색 폼(`#search`)을 `submit()`해 결과로 이동해야 통과. 브라우저 컨텍스트는 캐시 재사용 |

### 신세계 주의사항
- 헤드리스 탐지 회피: `--disable-blink-features=AutomationControlled` + `navigator.webdriver` 마스킹 필수.
- 직접 `goto(resultsTotal?query=...)` 는 403("연결 문제") → 반드시 폼 submit 경유.
- 첫 조회는 브라우저 기동 때문에 수 초 소요, 이후 컨텍스트 재사용으로 빨라짐.

## 상품 매칭 로직 (`clients.best_match`)

면세점마다 같은 모델의 표기가 다르고(신라·롯데 `파도바`, 신세계 `VVCC25`), **취급 품목도 달라 '해당 모델 미보유'가 흔하다**. 미보유 시 사이트는 부분일치로 무관한 상품을 잔뜩 반환하므로(`HTB12` 검색 → 롯데 `장생천 키즈 시럽`), **정밀도 우선**(틀린 가격보다 정직한 '조회 안 됨')으로 설계한다.

### 검색 키워드 (`main.choose_keyword`)
1. 상품명의 **모델코드(숫자 포함 영숫자 4자+, 예 `VVCC25`·`0RB3447001`)** 우선 — 보유처는 정확히 좁혀지고, 미보유면 `best_match`가 거른다.
2. 모델코드가 없으면 **가장 긴 토큰(`GUSSETED`·`CRESCENT` 등 고유 단어)** — 브랜드명보다 고유 단어로 검색해야 원하는 상품이 결과에 직접 들어온다.
3. 상품 토큰이 없으면 정제한 브랜드명.

### 후보 채택 (`clients.best_match`) — 정밀도 우선
- **모델코드가 상품명에 그대로 등장**(`model_hit`) → 채택(확실).
- 그 외엔 **브랜드 일치(동의어 포함) AND 식별 상품 토큰**이 있어야 채택. 둘 다 없으면 `None`(조회 안 됨).
- 모델코드 검색 결과가 **25개 이상(부분일치 폭발)**이면 `BR`·`50` 같은 2자 우연일치는 무시하고 3자+/강한 토큰을 요구.
- 상품 토큰에서 **브랜드 토큰은 제외**(브랜드명이 상품명에도 들어가면 오인됨).

### 브랜드 동의어 (`clients.BRAND_ALIASES`)
- 면세점은 영문 브랜드를 한글로 인덱싱(`RAYBAN`→`레이밴`) → 한↔영 교차 일치를 위한 사전. **새 브랜드는 여기 추가**.
- `_clean_brand`는 카테고리 접미사(`EYE`/`JEW`/`BAG` 등)·`(토산)` 괄호·기호를 제거해 브랜드 본명만 남긴다.
- `_norm`은 영문·숫자·**한글**만 남긴다(한글 상품명 매칭 필수).
- ※ 동명이브랜드 주의(`HUNTER` 아이웨어 vs 헌터 부츠) — 모델코드·상품 토큰 일치로 거른다.

## KRW 환산

- 롯데는 사이트가 정확한 원화를 제공 → 그대로 사용.
- 신라·신세계는 달러 판매가만 → 롯데가 제공한 환율로 환산(추정, UI에 `≈` 표기).

## 배포 메모 (미배포)

- VPS 배포 시 Playwright Chromium(ARM) 설치 필요(`playwright install chromium --with-deps`). 컨테이너 이미지가 커지므로(`mcr.microsoft.com/playwright` 베이스 권장) 신세계 조회 비중을 고려해 결정.
- 외부 사이트 구조에 의존하므로 셀렉터/엔드포인트 변경 시 깨질 수 있음 → 파서는 사이트별로 격리되어 한 곳이 실패해도 나머지는 표시됨(`errors` 필드).
