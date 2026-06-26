from fastapi import FastAPI, HTTPException, Query
from typing import Optional

# Import the existing CLI scrapers
from ImdbDataExtraction.search_by_string.search_by_string import search_all, format_results
from ImdbDataExtraction.search_by_id.search_movie import get_movie_details, format_movie_details
from ImdbDataExtraction.trending_downloader.trending_movies import get_trending_movies, extract_movie_ids
from ImdbDataExtraction.trending_downloader.trending_trailers import get_trending_trailers, extract_trailer_data
from ImdbDataExtraction.season_episodes.get_season_episodes import get_season_episodes
from ImdbDataExtraction.search_by_filters.search_by_filters import search_by_genre
from ImdbDataExtraction.streaming_availability.streaming_checker import get_streaming_availability
from ImdbDataExtraction.videos_downloader.extract_video_ids_from_gallery import get_all_title_videos
from ImdbDataExtraction.movie_info_downloader.download_movie_info import get_movie_info

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
        "docs": "Visit /docs for the API documentation",
        "usage": "Visit /use for API usage examples"
    }

@app.get("/use")
def api_usage_guide():
    """Returns documentation and examples on how to use all API endpoints."""
    return {
        "base_url": "https://cut-crew-all.onrender.com",
        "apis": [
            {
                "name": "Search by String",
                "endpoint": "/search/{query}",
                "description": "Search for movies, TV shows, and people by a string query.",
                "example_call": "fetch('https://cut-crew-all.onrender.com/search/inception?limit=10')"
            },
            {
                "name": "Get Movie Details",
                "endpoint": "/movie/{movie_id}",
                "description": "Get full movie/show details by its IMDb ID.",
                "example_call": "fetch('https://cut-crew-all.onrender.com/movie/tt0468569')"
            },
            {
                "name": "Get Movie Info (Fallback Schema)",
                "endpoint": "/movie_info/{movie_id}",
                "description": "Alternative endpoint for movie info mapping to the older JSON schema.",
                "example_call": "fetch('https://cut-crew-all.onrender.com/movie_info/tt23037654')"
            },
            {
                "name": "Search by Genre",
                "endpoint": "/search/genre/{genre}",
                "description": "Search movies by genre with advanced filters.",
                "example_call": "fetch('https://cut-crew-all.onrender.com/search/genre/comedy?limit=50&languages=hi&min_year=2022')"
            },
            {
                "name": "Get Trending Movies",
                "endpoint": "/trending/movies",
                "description": "Get currently trending movies.",
                "example_call": "fetch('https://cut-crew-all.onrender.com/trending/movies?count=8')"
            },
            {
                "name": "Get Trending Trailers",
                "endpoint": "/trending/trailers",
                "description": "Get currently trending trailers.",
                "example_call": "fetch('https://cut-crew-all.onrender.com/trending/trailers?limit=20')"
            },
            {
                "name": "Get Season Episodes",
                "endpoint": "/title/{series_id}/episodes",
                "description": "Get all episodes for a specific TV show/series.",
                "example_call": "fetch('https://cut-crew-all.onrender.com/title/tt0944947/episodes')"
            },
            {
                "name": "Check Streaming Availability",
                "endpoint": "/streaming/{title_id}",
                "description": "Check where a title is streaming.",
                "example_call": "fetch('https://cut-crew-all.onrender.com/streaming/tt0468569')"
            },
            {
                "name": "Get Videos from Gallery",
                "endpoint": "/videos/{title_id}",
                "description": "Get video IDs and metadata from a title's video gallery.",
                "example_call": "fetch('https://cut-crew-all.onrender.com/videos/tt0468569?limit=10')"
            }
        ]
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

@app.get("/movie_info/{movie_id}")
def api_get_movie_info(movie_id: str):
    """Alternative endpoint for movie info from JSON-LD schema (if available)."""
    try:
        with suppress_stdout():
            data = get_movie_info(movie_id)
        if not data:
            raise HTTPException(status_code=404, detail="Movie info not found or JSON-LD unavailable")
        return data
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/trending/movies")
def api_get_trending_movies(count: int = 8, data_window: str = "HOURS"):
    """Get trending movies."""
    try:
        with suppress_stdout():
            data = get_trending_movies(count, data_window)
            formatted_data = extract_movie_ids(data)
        return {"trending_movies": formatted_data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/trending/trailers")
def api_get_trending_trailers(limit: int = 50):
    """Get trending trailers."""
    try:
        with suppress_stdout():
            data = get_trending_trailers(limit)
            formatted_data = extract_trailer_data(data)
        return {"trending_trailers": formatted_data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/title/{series_id}/episodes")
def api_get_season_episodes(series_id: str, after_cursor: Optional[str] = None, limit: int = 50, include_extended: bool = True):
    """Get episodes for a specific TV show/series."""
    try:
        with suppress_stdout():
            data = get_season_episodes(series_id, after_cursor, limit, include_extended)
        return data
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

@app.get("/streaming/{title_id}")
def api_get_streaming_availability(title_id: str):
    """Check streaming availability for a specific title."""
    try:
        with suppress_stdout():
            data = get_streaming_availability(title_id)
        return data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/videos/{title_id}")
def api_get_videos(title_id: str, limit: int = 50, max_pages: Optional[int] = None):
    """Get video IDs and metadata from a title's gallery."""
    try:
        with suppress_stdout():
            data = get_all_title_videos(title_id, limit, max_pages)
        return {"videos": data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
