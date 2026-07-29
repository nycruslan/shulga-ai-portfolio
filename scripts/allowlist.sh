#!/usr/bin/env bash
# Manage the admin allowlist (ADMIN_ALLOWLIST) on Vercel.
#
#   ./scripts/allowlist.sh                       # show who's on it
#   ./scripts/allowlist.sh add a@x.com b@y.com   # add
#   ./scripts/allowlist.sh remove a@x.com        # remove
#   ./scripts/allowlist.sh set a@x.com b@y.com   # replace the whole list
#
# The owner (OWNER_EMAIL) is ALWAYS allowed and is not stored here — removing
# yourself from this list changes nothing.
#
# ⚠️ Source of truth is the LOCAL .env, deliberately.
# Vercel marks this variable "sensitive", so `vercel env pull` returns
# "[SENSITIVE]" rather than the value. A script that trusted that would read an
# empty list and silently drop everyone on the next `add`. So the local .env
# holds the list (it is gitignored), and every write updates both. If the two
# ever disagree, `set` re-establishes both from what you pass.
#
# ⚠️ A change needs a REDEPLOY. ALLOWLIST in src/lib/auth.ts is computed once at
# module load, so a running deployment keeps the old set until it restarts.

set -euo pipefail

ENVIRONMENT="${ENVIRONMENT:-production}"
VAR=ADMIN_ALLOWLIST

cd "$(dirname "$0")/.."
ENV_FILE=".env"

# Normalize exactly the way auth.ts does: split on comma/whitespace, trim,
# lowercase, drop blanks and duplicates. Keeps script and gate in agreement.
normalize() {
  tr ',[:space:]' '\n' | tr '[:upper:]' '[:lower:]' | sed '/^$/d' | sort -u
}

read_local() {
  [[ -f "$ENV_FILE" ]] || return 0
  grep -E "^${VAR}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true
}

write_local() {
  local value="$1"
  touch "$ENV_FILE"
  if grep -qE "^${VAR}=" "$ENV_FILE"; then
    # BSD sed (macOS) needs the empty -i argument.
    sed -i '' -E "s|^${VAR}=.*|${VAR}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$VAR" "$value" >> "$ENV_FILE"
  fi
}

CMD="${1:-list}"
shift || true

EXISTING="$(read_local | normalize || true)"

case "$CMD" in
  list)
    echo "environment: $ENVIRONMENT"
    echo "owner:       always allowed (OWNER_EMAIL), not in this list"
    echo "allowlist:   (from local $ENV_FILE — Vercel's copy is write-only)"
    if [[ -z "$EXISTING" ]]; then echo "  (empty)"; else echo "$EXISTING" | sed 's/^/  /'; fi
    exit 0
    ;;
  set)
    [[ $# -gt 0 ]] || { echo "set needs at least one email" >&2; exit 1; }
    NEXT="$(printf '%s\n' "$*" | normalize)"
    ;;
  add)
    [[ $# -gt 0 ]] || { echo "add needs at least one email" >&2; exit 1; }
    if [[ -z "$EXISTING" ]]; then
      echo "Refusing to add: no local copy of $VAR in $ENV_FILE." >&2
      echo "Vercel's copy is sensitive and cannot be read back, so adding now" >&2
      echo "would wipe anyone already on the list. Re-establish it explicitly:" >&2
      echo "  ./scripts/allowlist.sh set <every@email> <you@want> $*" >&2
      exit 1
    fi
    NEXT="$(printf '%s\n%s\n' "$EXISTING" "$*" | normalize)"
    ;;
  remove)
    [[ $# -gt 0 ]] || { echo "remove needs at least one email" >&2; exit 1; }
    NEXT="$EXISTING"
    for e in "$@"; do
      NEXT="$(printf '%s\n' "$NEXT" | grep -vixF "$(echo "$e" | tr '[:upper:]' '[:lower:]')" || true)"
    done
    ;;
  *) echo "usage: $0 [list|add|remove|set] [emails...]" >&2; exit 1 ;;
esac

JOINED="$(printf '%s\n' "$NEXT" | sed '/^$/d' | paste -sd, -)"
WAS="$(printf '%s\n' "$EXISTING" | sed '/^$/d' | paste -sd, -)"

if [[ "$JOINED" == "$WAS" ]]; then
  echo "no change"
  exit 0
fi

echo "was:  ${WAS:-(empty)}"
echo "now:  ${JOINED:-(empty)}"
echo

write_local "$JOINED"
vercel env rm "$VAR" "$ENVIRONMENT" --yes >/dev/null 2>&1 || true
printf '%s' "$JOINED" | vercel env add "$VAR" "$ENVIRONMENT" >/dev/null 2>&1

echo "updated $VAR on $ENVIRONMENT and in $ENV_FILE"
echo
echo "⚠️  Redeploy for it to take effect:"
echo "    vercel deploy --prod --yes"
