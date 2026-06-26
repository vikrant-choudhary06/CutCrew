
import sys
sys.path.append("e:/imdb-movie-scraper-main")
from ImdbDataExtraction.search_by_string.search_by_string import search_all
try:
    print(search_all("sapne "))
except Exception as e:
    print("ERROR:", e)
