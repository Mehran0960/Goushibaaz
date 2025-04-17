import os
import time
from apscheduler.schedulers.background import BackgroundScheduler
from youtube_service import fetch_trending_videos
from telegram_service import send_telegram_message
from dotenv import load_dotenv

load_dotenv()

YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

latest_video_id = None  # برای نگه‌داشتن آخرین ویدیو

def check_new_videos():
    global latest_video_id

    videos = fetch_trending_videos(YOUTUBE_API_KEY, max_results=1)
    if not videos:
        print("No videos fetched.")
        return

    video = videos[0]
    video_id = video.get("video_id")

    if video_id != latest_video_id:
        latest_video_id = video_id
        message = f"""**{video.get('title', 'عنوان نامشخص')}**
کانال: {video.get('channel', 'کانال نامشخص')}
منتشر شده در: {video.get('publishedAt', 'زمان نامشخص')}
[مشاهده در یوتیوب](https://www.youtube.com/watch?v={video_id})"""

        success = send_telegram_message(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, message)
        if success:
            print("ویدیوی جدید ارسال شد.")
        else:
            print("خطا در ارسال ویدیو.")
    else:
        print("ویدیوی جدیدی یافت نشد.")

def start_scheduler():
    scheduler = BackgroundScheduler()
    scheduler.add_job(check_new_videos, "interval", minutes=1)
    scheduler.start()