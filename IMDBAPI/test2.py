import requests
from bs4 import BeautifulSoup

r = requests.get('https://www.imdb.com/title/tt23037654/', headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'})
soup = BeautifulSoup(r.text, 'html.parser')
scripts = soup.find_all('script', id='__NEXT_DATA__')
print('__NEXT_DATA__ found:', len(scripts))
if scripts:
    print(scripts[0].string[:200])
