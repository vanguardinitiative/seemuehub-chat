#!/usr/bin/env bash
# Checks that conversation and message reads require the caller to be a
# participant. Run it against staging before deploying, and against production
# straight after.
#
# There is no server-side test harness in this repo, and these four routes talk
# to a live database, so this curl matrix is the end-to-end proof. The
# `no-token` rows are the regression that matters: before this change they
# returned 200 with both participants' fullName, phone and email.
#
#   CHAT_URL=https://chat.seemuehub.com/v1/api \
#   TOKEN=<an access token> \
#   MINE=<a conversation you are in> \
#   THEIRS=<a conversation you are not in> \
#   ./scripts/verify-auth.sh
set -u

CHAT_URL="${CHAT_URL:-http://localhost:3001/v1/api}"
: "${TOKEN:?set TOKEN to an access token}"
: "${MINE:?set MINE to a conversation id you are a participant of}"
: "${THEIRS:?set THEIRS to a conversation id you are NOT a participant of}"

fail=0

check() {
  local label="$1" expected="$2"; shift 2
  local actual
  actual=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@")
  if [ "$actual" = "$expected" ]; then
    printf '  ok   %-42s %s\n' "$label" "$actual"
  else
    printf '  FAIL %-42s got %s, want %s\n' "$label" "$actual" "$expected"
    fail=1
  fi
}

echo "verifying $CHAT_URL"

# Unauthenticated reads must not reach the handler at all.
check "conversation, no token"        401 "$CHAT_URL/conversations/$MINE"
check "messages, no token"            401 "$CHAT_URL/messages?conversationId=$MINE"
check "history, no token"             401 "$CHAT_URL/messages/histories?orderId=x"
check "create private, no token"      401 -X POST "$CHAT_URL/conversations/private" \
      -H 'Content-Type: application/json' -d '{"receiverId":"x"}'

# A participant still sees their own conversation.
check "own conversation"              200 -H "Authorization: Bearer $TOKEN" "$CHAT_URL/conversations/$MINE"
check "own messages"                  200 -H "Authorization: Bearer $TOKEN" "$CHAT_URL/messages?conversationId=$MINE"

# A non-participant gets the same answer as "no such conversation" — a 403 would
# confirm the id is real, which is what an enumerator is after.
check "someone else's conversation"   404 -H "Authorization: Bearer $TOKEN" "$CHAT_URL/conversations/$THEIRS"
check "someone else's messages"       404 -H "Authorization: Bearer $TOKEN" "$CHAT_URL/messages?conversationId=$THEIRS"

# A junk id is a bad request, not a CastError surfacing as a 500.
check "malformed conversation id"     400 -H "Authorization: Bearer $TOKEN" "$CHAT_URL/conversations/not-an-objectid"

# Unchanged behaviour, included so a regression here is caught too.
check "conversation list"             200 -H "Authorization: Bearer $TOKEN" "$CHAT_URL/conversations?skip=0&limit=1"

exit $fail
