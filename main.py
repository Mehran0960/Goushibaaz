import os
import requests
from flask import Flask
from apscheduler.schedulers.background import BackgroundScheduler
from dotenv import load_dotenv
from youtube_service import fetch_trending_videos
from telegram_service import send_to_telegram
from utils import get_last_video_id, set_last_video_id

# بارگذاری متغیرهای محیطی و چاپ API Key
load_dotenv()
YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY")
print("Loaded YOUTUBE_API_KEY:", YOUTUBE_API_KEY)

app = Flask(__name__)
last_video_id = get_last_video_id()

def check_and_send():
    global last_video_id
    print("Checking for new videos…")
    videos = fetch_trending_videos(YOUTUBE_API_KEY)
    if not videos:
        print("No videos found.")
        return

    latest = videos[0]
    vid = latest["id"]
    if vid == last_video_id:
        print("No new video to send.")
        return

    print("New video detected:", latest["title"], vid)
    send_to_telegram(latest)
    set_last_video_id(vid)
    last_video_id = vid

# زمان‌بندی هر دقیقه
scheduler = BackgroundScheduler()
scheduler.add_job(check_and_send, "interval", minutes=1)
scheduler.start()

@app.route("/")
def home():
    return "GoushiBaaz is alive!"

@app.route("/ping")
def ping():
    return "pong"

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=3000)