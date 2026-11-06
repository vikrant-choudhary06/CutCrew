from fastapi import FastAPI, HTTPException, Query
from typing import Optional

# Import the existing CLI scrapers
from ImdbDataExtraction.search_by_string.search_by_string import search_all, format_results
from ImdbDataExtraction.search_by_id.search_movie import get_movie_details, format_movie_details
from ImdbDataExtraction.search_by_filters.search_by_filters import search_by_genre

from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(
    title="IMDb Open API",
    description="An open API wrapping the IMDb CLI Scrapers. No API keys required.",
    version="1.0.0"
)

import sys
import os
from contextlib import contextmanager

@contextmanager
def suppress_stdout():
    with open(os.devnull, "w", encoding="utf-8") as devnull:
        old_stdout = sys.stdout
        sys.stdout = devnull
        try:
            yield
        finally:
            sys.stdout = old_stdout

# Enable CORS for everyone
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def root():
    return {
        "message": "Welcome to the IMDb Open API!",
        "docs": "Visit /docs for the API documentation"
    }

@app.get("/search/{query}")
def api_search_by_string(query: str, limit: int = 20):
    """Search for movies, TV shows, and people by a string query."""
    try:
        with suppress_stdout():
            data = search_all(query, limit)
            results = format_results(data, limit)
        return {"query": query, "results": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/movie/{movie_id}")
def api_get_movie_details(movie_id: str):
    """Get full movie details by its IMDb ID (e.g., tt0468569)."""
    try:
        # get_movie_details might print to stdout. We just return the dictionary.
        with suppress_stdout():
            data = get_movie_details(movie_id)
            formatted_data = format_movie_details(data)
        if not formatted_data:
            raise HTTPException(status_code=404, detail="Movie not found")
        return formatted_data
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/search/genre/{genre}")
def api_search_by_genre(
    genre: str,
    limit: int = 50,
    languages: Optional[str] = None,
    min_year: Optional[int] = None,
    max_year: Optional[int] = None,
    min_rating: Optional[float] = None,
    max_rating: Optional[float] = None,
    title_type: Optional[str] = None,
    after_cursor: Optional[str] = None
):
    """Search movies by genre and filters."""
    try:
        with suppress_stdout():
            data = search_by_genre(
                target_genre=genre.capitalize(),
                limit=limit,
                languages=languages,
                min_year=min_year,
                max_year=max_year,
                min_rating=min_rating,
                max_rating=max_rating,
                title_type=title_type,
                after_cursor=after_cursor
            )
        return data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
