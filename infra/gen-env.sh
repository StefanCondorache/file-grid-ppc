#!/usr/bin/env bash
# Creates infra/.env from infra/.env.example with random secrets. No-op if it already exists.
set -euo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="$dir/.env"
example="$dir/.env.example"

if [[ -e "$env_file" ]]; then
  echo "infra/.env already exists; leaving it unchanged."
  exit 0
fi
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

rand() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 24; }

# Build the whole content in memory first, so a failure never leaves a half-written .env.
content=""
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" == *=change-me ]]; then
    line="${line%change-me}$(rand)"
  fi
  content+="$line"$'\n'
done < "$example"

umask 077
printf '%s' "$content" > "$env_file"
chmod 600 "$env_file"
echo "Created infra/.env with generated secrets (chmod 600)."
