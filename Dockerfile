FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY requirements.txt .
# 의존성 설치 + Chromium(신세계 WAF 우회용) + 시스템 라이브러리
RUN pip install --no-cache-dir -r requirements.txt \
 && playwright install --with-deps chromium

COPY . .

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
