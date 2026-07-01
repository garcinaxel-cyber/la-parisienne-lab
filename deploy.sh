#!/bin/bash
# deploy.sh — run from the la-parisienne-lab directory in your terminal
# Usage: bash deploy.sh "commit message"

set -e
cd "$(dirname "$0")"

MSG="${1:-chore: update lab app}"

# Remove stale lock if present
rm -f .git/index.lock

# Add GitHub remote if not already set
if ! git remote get-url origin &>/dev/null; then
  git remote add origin https://github.com/garcinaxel-cyber/la-parisienne-lab.git
  echo "✅ Remote added"
fi

git add -A
git commit -m "$MSG"
git push -u origin main

echo ""
echo "✅ Pushed to GitHub — Vercel will auto-deploy in ~1 min"
echo "   https://la-parisienne-lab.vercel.app"
