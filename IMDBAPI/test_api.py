import requests

res1 = requests.get("http://localhost:8000/search/sapne%20")
print("Search:", res1.status_code, res1.text)

res2 = requests.get("http://localhost:8000/videos/tt30263074?limit=10&max_pages=1")
print("Videos:", res2.status_code, res2.text)
