# IMDb API (CutCrew catalogue scraper)

A small FastAPI service the backend uses for title details and search
(`SCRAPER_URL`, `http://imdbapi:8000` in Docker Compose). Only the endpoints
CutCrew calls are kept:

| Endpoint | Used for |
|---|---|
| `GET /movie/{imdb_id}` | Full title details |
| `GET /search/{query}?limit=` | Search by text |
| `GET /search/genre/{genre}?limit=` | Titles by genre (with optional language, year and rating filters) |
| `GET /` | Health check |

Run locally: `pip install -r requirements.txt`, then `uvicorn main:app --port 8000`.
The scrapers are in `ImdbDataExtraction/` (search by string, by ID and by filters).
