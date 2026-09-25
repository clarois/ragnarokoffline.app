#!/usr/bin/env bash
# Dispatch the installer build, refusing to start until the server images for the
# commit being built have actually been PUBLISHED.
#
# Why this exists: a build was dispatched 10 minutes after the push, while the
# images run for that same commit was still going. The build fetched the *previous*
# image from the rolling release, so the installer shipped old server code with new
# client code - and the bug it was supposed to fix was still present. Nothing
# errored; the artifact simply contained the wrong half.
#
# The images workflow publishes to the rolling release tag "images". So: read the
# asset's timestamp, and require it to be newer than the commit's push time. Only
# then dispatch.
set -u
GH=/home/msi/.local/bin/gh
REPO=clarois/ragnarokoffline.app
MAX_WAIT_SECS="${MAX_WAIT_SECS:-2400}"
POLL="${POLL:-30}"

echo "== commit to build: $(cd /home/msi/repos/ragnarokoffline.app && git rev-parse --short=7 HEAD)"

# Push time of HEAD on the remote (authoritative, not local mtime).
PUSHED=$($GH api "repos/$REPO/commits/main" --jq '.commit.committer.date' 2>/dev/null)
[ -n "$PUSHED" ] || { echo "cannot read main's commit date"; exit 1; }
PUSHED_EPOCH=$(date -u -d "$PUSHED" +%s)
echo "== main pushed at: $PUSHED"

waited=0
while :; do
  IMG=$($GH api "repos/$REPO/releases/tags/images" \
        --jq '.assets[] | select(.name=="images-x64.tar.gz") | .updated_at' 2>/dev/null)
  if [ -n "$IMG" ]; then
    IMG_EPOCH=$(date -u -d "$IMG" +%s)
    echo "   images-x64.tar.gz updated at: $IMG"
    if [ "$IMG_EPOCH" -ge "$PUSHED_EPOCH" ]; then
      echo "== images for this commit are published"
      break
    fi
    echo "   stale: images predate the commit ($((PUSHED_EPOCH - IMG_EPOCH))s older) - waiting"
  else
    echo "   no images asset found yet - waiting"
  fi
  sleep "$POLL"
  waited=$((waited + POLL))
  if [ "$waited" -ge "$MAX_WAIT_SECS" ]; then
    echo "TIMEOUT: images not published after ${MAX_WAIT_SECS}s - NOT dispatching"
    exit 1
  fi
done

# Also require the images run for this exact commit to have succeeded, so a stale
# release asset from an unrelated run cannot satisfy the check above.
SHA=$(cd /home/msi/repos/ragnarokoffline.app && git rev-parse HEAD)
RUN=$($GH run list --repo "$REPO" --workflow=images.yml --limit 12 \
      --json databaseId,headSha,status,conclusion \
      --jq ".[] | select(.headSha==\"$SHA\") | .databaseId" 2>/dev/null | head -1)
if [ -n "$RUN" ]; then
  for i in $(seq 1 40); do
    ST=$($GH api "repos/$REPO/actions/runs/$RUN" --jq '.status + " " + (.conclusion // "-")' 2>/dev/null)
    case "$ST" in
      completed\ success) echo "== images run $RUN succeeded for ${SHA:0:7}"; break ;;
      completed\ *) echo "images run $RUN did not succeed ($ST) - NOT dispatching"; exit 1 ;;
    esac
    sleep "$POLL"
  done
else
  echo "WARNING: no images run found for ${SHA:0:7}; relying on the asset timestamp"
fi

for t in 1 2 3; do
  OUT=$($GH api -X POST "repos/$REPO/actions/workflows/build.yml/dispatches" -f ref=main 2>&1)
  echo "$OUT" | grep -q "error connecting" || break
  sleep 8
done
sleep 12
BID=$($GH run list --repo "$REPO" --workflow=build.yml --limit 1 --json databaseId --jq '.[0].databaseId')
echo "BUILD_DISPATCHED id=$BID"
echo "$BID" > /home/msi/last_build_id
