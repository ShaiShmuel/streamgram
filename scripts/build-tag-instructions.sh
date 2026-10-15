#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

# Rebuild every language by default, or pass language codes (e.g. he ru ar).
languages=("$@")
if [ ${#languages[@]} -eq 0 ]; then
  languages=(en he ru ar)
fi

for language in "${languages[@]}"; do
  case "$language" in en|he|ru|ar) ;; *) echo "Unsupported language: $language" >&2; exit 1 ;; esac
  # Encode ten minutes once, then repeat the encoded packets for three hours.
  # Silent audio improves compatibility with TV media players.
  ffmpeg -hide_banner -loglevel error \
    -loop 1 -framerate 1 -i "public/assets/tag-assistant/instructions-$language.png" \
    -f lavfi -i anullsrc=r=48000:cl=stereo -t 600 \
    -vf scale=1920:1080 -c:v libx264 -preset slow -tune stillimage \
    -crf 26 -x264-params psy=0 -pix_fmt yuv420p -r 1 -g 600 -c:a aac -b:a 32k \
    -movflags +faststart -y "$work_dir/segment.mp4"
  ffmpeg -hide_banner -loglevel error \
    -stream_loop 17 -i "$work_dir/segment.mp4" -t 10800 \
    -c copy -movflags +faststart -y "public/assets/tag-assistant/instructions-$language.mp4"
done
