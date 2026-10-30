#!/usr/bin/env bash
set -euo pipefail

FILE_PATH="${1:?state file path is required}"
COMMIT_MESSAGE="${2:?commit message is required}"
WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"

case "$FILE_PATH" in
  /*|../*|*/../*)
    echo "Refusing unsafe repository path: $FILE_PATH" >&2
    exit 2
    ;;
esac

SOURCE_FILE="$WORKSPACE/$FILE_PATH"
if [[ ! -f "$SOURCE_FILE" ]]; then
  echo "State file does not exist; nothing to persist: $FILE_PATH"
  exit 0
fi

TMP_ROOT="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
TMP_WORKTREE="$(mktemp -d "$TMP_ROOT/goushibaaz-state.XXXXXX")"

cleanup() {
  cd "$WORKSPACE"
  git worktree remove --force "$TMP_WORKTREE" >/dev/null 2>&1 || rm -rf "$TMP_WORKTREE"
}
trap cleanup EXIT

git fetch origin main
git worktree add --detach "$TMP_WORKTREE" origin/main
mkdir -p "$TMP_WORKTREE/$(dirname "$FILE_PATH")"
cp "$SOURCE_FILE" "$TMP_WORKTREE/$FILE_PATH"

cd "$TMP_WORKTREE"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add "$FILE_PATH"

if git diff --cached --quiet; then
  echo "State file is unchanged on main: $FILE_PATH"
  exit 0
fi

git commit -m "$COMMIT_MESSAGE"
for attempt in 1 2 3 4; do
  git fetch origin main
  if ! git rebase origin/main; then
    git rebase --abort || true
    sleep "$attempt"
    continue
  fi
  if git push origin HEAD:main; then
    echo "Persisted state file in isolated worktree: $FILE_PATH"
    exit 0
  fi
  sleep "$attempt"
done

echo "Unable to persist state file after four attempts: $FILE_PATH" >&2
exit 1
