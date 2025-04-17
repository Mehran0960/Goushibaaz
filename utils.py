def get_last_video_id():
  try:
      with open("last_video.txt", "r") as f:
          return f.read().strip()
  except FileNotFoundError:
      return None

def set_last_video_id(video_id):
  with open("last_video.txt", "w") as f:
      f.write(video_id)