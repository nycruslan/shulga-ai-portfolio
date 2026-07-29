#!/usr/bin/env bash
# Manage the admin allowlist on Vercel.
#
#   ./scripts/allowlist.sh                       # show who's on it
#   ./scripts/allowlist.sh add a@x.com b@y.com   # add
#   ./scripts/allowlist.sh remove a@x.com        # remove
#
# The owner (OWNER_EMAIL) is ALWAYS allowed and is not stored here — removing
# yourself from this list changes nothing.
#
# ⚠️ A change needs a REDEPLOY to take effect. ALLOWLIST in src/lib/auth.ts is
# computed once at module load, so a running deployment keeps the old set until
# it restarts. The script reminds you at the end.

set -euo pipefail

ENVIRONMENT="${ENVIRONMENT:-production}"
VAR=ADMIN_ALLOWLIST
TMP="$(mktemp -t allowlist)"
trap 'rm -f "$TMP"' EXIT

cd "$(dirname "$0")/.."

current() {
  vercel env pull "$TMP" --environment="$ENVIRONMENT" --yes >/dev/null 2>&1 || true
  # Value may or may not be quoted depending on CLI version.
  grep -E "^${VAR}=" "$TMP" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true
}

# Normalize the way auth.ts does: split on comma/whitespace, trim, lowercase,
# drop blanks and duplicates. Keeps this script and the gate in agreement.
normalize() {
  tr ',[:space:]' '\n' | tr '[:upper:]' '[:lower:]' | sed '/^$/d' | sort -u
}

CMD="${1:-list}"
shift || true

EXISTING="$(current | normalize || true)"

case "$CMD" in
  list)
    echo "environment: $ENVIRONMENT"
    echo "owner:       always allowed (OWNER_EMAIL), not in this list"
    echo "allowlist:"
    if [[ -z "$EXISTING" ]]; then echo "  (empty)"; else echo "$EXISTING" | sed 's/^/  /'; fi
    exit 0
    ;;
  add)    NEXT="$(printf '%s\n%s\n' "$EXISTING" "$*" | normalize)" ;;
  remove)
    NEXT="$EXISTING"
    for e in "$@"; do
      NEXT="$(printf '%s\n' "$NEXT" | grep -vixF "$(echo "$e" | tr '[:upper:]' '[:lower:]')" || true)"
    done
    ;;
  *) echo "usage: $0 [list|add|remove] [emails...]" >&2; exit 1 ;;
esac

JOINED="$(printf '%s\n' "$NEXT" | sed '/^$/d' | paste -sd, -)"

if [[ "$JOINED" == "$(printf '%s\n' "$EXISTING" | sed '/^$/d' | paste -sd, -)" ]]; then
  echo "no change"
  exit 0
fi

echo "was:  ${EXISTING//$'\n'/, }"
echo "now:  $JOINED"
echo

vercel env rm "$VAR" "$ENVIRONMENT" --yes >/dev/null 2>&1 || true
printf '%s' "$JOINED" | vercel env add "$VAR" "$ENVIRONMENT" >/dev/null 2>&1

echo "updated $VAR on $ENVIRONMENT"
echo
echo "⚠️  Redeploy for it to take effect:"
echo "    vercel deploy --prod --yes"
