import os
import sys
# Add the root directory to sys.path so imports work when run directly
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import json
from ImdbDataExtraction.search_by_id.search_movie import get_movie_details, format_movie_details

def get_movie_info(movie_id):
    """Extract movie information using the GraphQL API as fallback for the removed JSON-LD"""
    try:
        # Fetch raw GraphQL data
        raw_data = get_movie_details(movie_id)
        if not raw_data or not raw_data.get("data", {}).get("title"):
            return None
            
        # Parse using the existing formatter
        formatted = format_movie_details(raw_data)
        if not formatted:
            return None
            
        # Map to the old JSON-LD schema structure to maintain backwards compatibility
        info = {
            'id': movie_id,
            'title': formatted.get('title'),
            'description': formatted.get('plot'),
            'image': formatted.get('poster_url'),
            'url': formatted.get('imdb_url'),
            'datePublished': formatted.get('release_date'),
            'duration': f"PT{formatted.get('runtime_minutes', 0)}M" if formatted.get('runtime_minutes') else None,
            'genre': formatted.get('genres', []),
            'keywords': ','.join(formatted.get('keywords', [])) if formatted.get('keywords') else None,
            'aggregateRating': {
                'ratingValue': formatted.get('rating'),
                'ratingCount': formatted.get('vote_count')
            } if formatted.get('rating') else {},
            
            # Use the enhanced credits if available
            'actors': [{'name': actor.get('name'), 'url': actor.get('url')} for actor in formatted.get('enhanced_actors', [])],
            'directors': [{'name': director.get('name'), 'url': director.get('url')} for director in formatted.get('enhanced_directors', [])],
            'creators': [{'name': creator.get('name'), 'url': creator.get('url'), 'type': creator.get('type')} for creator in formatted.get('enhanced_creators', [])],
            
            'trailer': {
                'name': formatted.get('trailer', {}).get('name'),
                'url': formatted.get('trailer', {}).get('url'),
                'embedUrl': formatted.get('trailer', {}).get('embedUrl'),
                'thumbnail': formatted.get('trailer', {}).get('thumbnail'),
                'duration': f"PT{formatted.get('trailer', {}).get('duration', 0)}S" if formatted.get('trailer', {}).get('duration') else None,
                'uploadDate': formatted.get('trailer', {}).get('uploadDate')
            } if formatted.get('trailer') else {},
            
            'review': {
                'total': formatted.get('review_count')
            } if formatted.get('review_count') else {}
        }
        
        return info
    except Exception as e:
        print(f"Error extracting movie info: {e}")
        return None

def save_movie_info(movie_info, filename):
    """Save movie info to JSON file"""
    with open(filename, 'w', encoding='utf-8') as f:
        json.dump(movie_info, f, indent=2, ensure_ascii=False)
    print(f"Movie info saved to {filename}")

if __name__ == "__main__":
    # Example movie ID
    movie_id = "tt23849204"
    
    print(f"Fetching movie info for {movie_id}...")
    movie_info = get_movie_info(movie_id)
    
    if movie_info:
        filename = f"{movie_id}_info.json"
        save_movie_info(movie_info, filename)
        
        print(f"\nMovie: {movie_info.get('title')}")
        print(f"Year: {movie_info.get('datePublished', '').split('-')[0] if movie_info.get('datePublished') else ''}")
        print(f"Rating: {movie_info.get('aggregateRating', {}).get('ratingValue')}")
        print(f"Genres: {', '.join(movie_info.get('genre', []))}")
    else:
        print("Failed to extract movie information")