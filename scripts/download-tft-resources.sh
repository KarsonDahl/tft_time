#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/data/riot"
mkdir -p "$OUT_DIR"

latest_version="$(python - <<'PY'
import json
import urllib.request
req = urllib.request.Request(
    'https://ddragon.leagueoflegends.com/api/versions.json',
    headers={'User-Agent': 'Mozilla/5.0'},
)
with urllib.request.urlopen(req, timeout=30) as response:
    versions = json.load(response)
print(versions[0])
PY
)"

echo "Using Riot Data Dragon version $latest_version"

curl -fsSL -A 'Mozilla/5.0' -o "$OUT_DIR/communitydragon-tft-en_us.json" \
  https://raw.communitydragon.org/latest/cdragon/tft/en_us.json

curl -fsSL -L -A 'Mozilla/5.0' -o "$OUT_DIR/dragontail-$latest_version.tgz" \
  "https://ddragon.leagueoflegends.com/cdn/dragontail-$latest_version.tgz"

echo "Downloaded TFT resources to $OUT_DIR"
