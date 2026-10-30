FROM python:3.12-slim
WORKDIR /app
COPY IMDBAPI/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY IMDBAPI/ ./
RUN useradd --create-home app && chown -R app:app /app
USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/',timeout=4)"
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
