#!/usr/bin/env bash
set -euo pipefail

# Re-vendor capture/Sources/AudioCapture.swift (+ LICENSE) from upstream ownscribe.
#
# Usage:
#   scripts/sync-capture.sh [REF]            # dry run: fetch REF and print the diff
#   scripts/sync-capture.sh [REF] --apply    # copy the source, bump UPSTREAM, rebuild
#
# REF is a branch, tag, or commit (default: the ref recorded in capture/UPSTREAM).
# AudioCapture.swift + LICENSE sync verbatim; build.sh is only diffed (we deviate on
# BIN_DIR), so an upstream change to frameworks/flags surfaces for manual reconcile.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CAPTURE_DIR="$REPO_ROOT/capture"
UPSTREAM_FILE="$CAPTURE_DIR/UPSTREAM"

APPLY=0
REF=""
for arg in "$@"; do
  case "$arg" in
    --apply)   APPLY=1 ;;
    -h|--help) sed -n '4,13p' "$0"; exit 0 ;;
    -*)        echo "unknown flag: $arg" >&2; exit 2 ;;
    *)         REF="$arg" ;;
  esac
done

get() { grep -E "^$1=" "$UPSTREAM_FILE" | head -1 | cut -d= -f2- || true; }
REPO="$(get repo)"
SWIFT_PATH="$(get swift_path)"
PINNED="$(get commit)"
REF="${REF:-$(get ref)}"
[ -n "$REPO" ] || { echo "ERROR: repo= missing in $UPSTREAM_FILE" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching $REPO @ $REF ..."
if ! git clone --quiet --depth 1 --branch "$REF" "$REPO" "$TMP/up" 2>/dev/null; then
  echo "  (shallow branch/tag clone failed — full clone to resolve a commit)"
  git clone --quiet "$REPO" "$TMP/up"
  git -C "$TMP/up" checkout --quiet "$REF"
fi

NEW_COMMIT="$(git -C "$TMP/up" rev-parse HEAD)"
NEW_DATE="$(git -C "$TMP/up" log -1 --format=%cd --date=short)"

UP_SWIFT="$TMP/up/$SWIFT_PATH"
UP_LICENSE="$TMP/up/LICENSE"
UP_BUILD="$TMP/up/swift/build.sh"
[ -f "$UP_SWIFT" ] || { echo "ERROR: $SWIFT_PATH not found upstream — layout changed?" >&2; exit 1; }

echo
echo "  pinned  : $PINNED"
echo "  upstream: $NEW_COMMIT ($NEW_DATE)"
echo

echo "=== AudioCapture.swift (vendored → upstream) ==="
diff -u "$CAPTURE_DIR/Sources/AudioCapture.swift" "$UP_SWIFT" && echo "  (identical)" || true
echo
echo "=== LICENSE ==="
diff -u "$CAPTURE_DIR/LICENSE" "$UP_LICENSE" && echo "  (identical)" || true
echo
echo "=== build.sh (NOT auto-synced — we deviate on BIN_DIR; reconcile by hand) ==="
if [ -f "$UP_BUILD" ]; then
  diff -u "$CAPTURE_DIR/build.sh" "$UP_BUILD" && echo "  (identical)" || true
else
  echo "  (upstream swift/build.sh not found)"
fi

if [ "$APPLY" -ne 1 ]; then
  echo
  if [ "$NEW_COMMIT" = "$PINNED" ]; then
    echo "Dry run — already at the pinned commit. Re-run with --apply to force a re-vendor + rebuild."
  else
    echo "Dry run. Re-run with --apply to copy the source, bump UPSTREAM to $NEW_COMMIT, and rebuild."
  fi
  exit 0
fi

echo
echo "Applying..."
cp "$UP_SWIFT" "$CAPTURE_DIR/Sources/AudioCapture.swift"
echo "  WARNING: overwrote AudioCapture.swift — RE-APPLY the 5 local patches (search 'LOCAL"
echo "           PATCH'; see capture/README.md): (1) --max-duration, else 'murmur record' fails"
echo "           with 'Unknown option: --max-duration'; (2) the request-mic subcommand; (3) the"
echo "           self-disclaim re-exec — without (2)+(3), menubar recordings silently lose the"
echo "           mic; and (4) the watch-mic subcommand — without it, meeting auto-detection no-ops"
echo "           (murmur doctor warns); and (5) the merge-time mic gate (micGateMap) — without it"
echo "           speaker audio is recorded twice, 30–100 ms apart. The build re-signs with"
echo "           the stable identity, so grants persist."
cp "$UP_LICENSE" "$CAPTURE_DIR/LICENSE"
sed -E -i.bak "s/^commit=.*/commit=$NEW_COMMIT/" "$UPSTREAM_FILE" && rm -f "$UPSTREAM_FILE.bak"

echo "Rebuilding..."
bash "$CAPTURE_DIR/build.sh"
"$CAPTURE_DIR/bin/ownscribe-audio" --help >/dev/null 2>&1 && echo "smoke test: ok"

echo
echo "Done — vendored at $NEW_COMMIT."
echo "  1. Review:    git diff capture/"
echo "  2. Reinstall: install -m755 capture/bin/ownscribe-audio ~/.local/bin/ownscribe-audio"
echo "  3. Commit."
