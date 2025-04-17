import requests

def fetch_trending_videos(api_key, max_results=5):
    url = "https://www.googleapis.com/youtube/v3/videos"
    params = {
       "part": "snippet",
       "chart": "mostPopular",
       "regionCode": "US",
       "videoCategoryId": "28",
       "maxResults": max_results,
       "key": api_key
    }
    # لاگ‌کردن URL و وضعیت پاسخ
    response = requests.get(url, params=params)
    print(">>> YouTube Request URL:", response.url)
    print(">>> YouTube status code:", response.status_code)
    print(">>> YouTube response body:", response.text[:500])  # ۵۰۰ کاراکتر اول

    items = response.json().get("items", [])
    videos = []
    for it in items:
        sn = it["snippet"]
        videos.append({
            "id":        it["id"],
            "title":     sn["title"],
            "channel":   sn["channelTitle"],
            "published": sn["publishedAt"]
        })
    return videos