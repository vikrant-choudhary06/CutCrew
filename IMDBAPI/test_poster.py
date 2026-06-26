import requests
from bs4 import BeautifulSoup
import re

def get_correct_poster(imdb_id):
    url = f"https://www.imdb.com/title/{imdb_id}/"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
    }
    response = requests.get(url, headers=headers)
    if response.status_code == 200:
        soup = BeautifulSoup(response.text, 'html.parser')
        og_image = soup.find('meta', property='og:image')
        if og_image and og_image.get('content'):
            return og_image['content']
    return None

print("Schindler's list:", get_correct_poster('tt0108052'))
print("Pulp Fiction:", get_correct_poster('tt0110912'))
