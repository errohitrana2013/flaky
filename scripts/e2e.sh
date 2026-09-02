#!/bin/bash
# End-to-end check of the live site. Asserts rather than prints, so a wrong
# answer is a failure line and not something to spot by eye.
U=${1:-https://flakyapi.dev}
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { FAIL=$((FAIL+1)); printf "  \033[31m✗\033[0m %s — %s\n" "$1" "$2"; }
is()   { [ "$2" = "$3" ] && ok "$1" || bad "$1" "expected $3, got $2"; }
has()  { echo "$2" | grep -q "$3" && ok "$1" || bad "$1" "missing: $3"; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$@"; }

echo "── target: $U"

echo; echo "PAGES & ASSETS"
for p in / /custom /dashboard /app.css /app.js /custom.css /custom.js /dashboard.css /dashboard.js /favicon.svg /logo.svg; do
  is "GET $p" "$(code "$U$p")" "200"
done
is "unknown page 404s" "$(code "$U/no-such-page")" "404"

echo; echo "SECURITY HEADERS (page)"
H=$(curl -sD - -o /dev/null --max-time 25 "$U/")
for h in content-security-policy x-frame-options x-content-type-options strict-transport-security referrer-policy permissions-policy; do
  has "$h" "$(echo "$H" | tr 'A-Z' 'a-z')" "$h"
done
has "CSP has no unsafe-inline" "$(echo "$H" | grep -i content-security-policy | grep -vc unsafe-inline)" "1"

echo; echo "SECURITY HEADERS (api)"
HA=$(curl -sD - -o /dev/null --max-time 25 "$U/v1/posts?_limit=1" | tr 'A-Z' 'a-z')
has "nosniff" "$HA" "x-content-type-options: nosniff"
has "api CSP is default-src none" "$HA" "default-src 'none'"
has "cors exposed" "$HA" "access-control-expose-headers"

echo; echo "READS"
is "list" "$(code "$U/v1/posts?_limit=2")" "200"
is "total-count header" "$(curl -sD - -o /dev/null --max-time 25 "$U/v1/posts?_limit=2" | grep -i '^x-total-count' | tr -d '\r' | awk '{print $2}')" "100"
is "single record" "$(curl -s --max-time 25 "$U/v1/posts/1" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')" "1"
is "nested" "$(curl -s --max-time 25 "$U/v1/posts/1/comments" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(all(c["postId"]==1 for c in d) and len(d)>0)')" "True"
is "filter" "$(curl -s --max-time 25 "$U/v1/todos?userId=3&_limit=50" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(all(t["userId"]==3 for t in d) and len(d)>0)')" "True"
is "sort desc" "$(curl -s --max-time 25 "$U/v1/products?_sort=price&_order=desc&_limit=5" | python3 -c 'import sys,json;p=[x["price"] for x in json.load(sys.stdin)];print(p==sorted(p,reverse=True))')" "True"
is "search" "$(code "$U/v1/posts?_q=voluptate")" "200"
is "page cap at tier max" "$(curl -s --max-time 25 "$U/v1/photos?_limit=9999" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')" "100"
is "unknown resource" "$(code "$U/v1/nonsense")" "404"
is "unknown nested" "$(code "$U/v1/posts/1/nonsense")" "404"
is "missing id" "$(code "$U/v1/posts/99999")" "404"

echo; echo "CHAOS"
is "_status=503" "$(code "$U/v1/posts?_status=503")" "503"
is "_status=404" "$(code "$U/v1/posts?_status=404")" "404"
is "_status=200 behaves normally" "$(code "$U/v1/posts?_status=200&_limit=1")" "200"
is "_fail_rate=1" "$(code "$U/v1/posts?_fail_rate=1")" "500"
is "_fail_rate=0" "$(code "$U/v1/posts?_fail_rate=0&_limit=1")" "200"
T=$(curl -s -o /dev/null -w '%{time_total}' --max-time 30 "$U/v1/posts?_delay=1500")
[ "$(echo "$T > 1.4" | bc)" = "1" ] && ok "_delay=1500 waited ${T}s" || bad "_delay" "only ${T}s"

echo; echo "VALIDATION (must 400, never silently ignore)"
for q in _status=999 _status=abc _status=503.5 _fail_rate=2 _fail_rate=-1 _fail_rate=abc _delay=99999 _delay=-500 _delay=abc _page=abc _page=0 _page=-1 _limit=abc _limit=0 _limit=-1; do
  is "$q" "$(code "$U/v1/posts?$q")" "400"
done
is "empty params ignored" "$(code "$U/v1/posts?_status=&_delay=&_fail_rate=&_limit=1")" "200"

echo; echo "INPUT SAFETY"
R=$(curl -s --max-time 25 "$U/v1/posts?_status=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E")
echo "$R" | grep -q "unprintable" && ok "payload refused, not echoed" || bad "echo" "$R"
echo "$R" | grep -qE "[<>]" && bad "angle brackets in body" "$R" || ok "no angle brackets in body"
is "sql-ish input handled" "$(code "$U/v1/posts?userId=1'%20OR%20'1'='1")" "200"
# Rejected rather than ignored: __proto__ starts with an underscore, so it is
# an unknown control parameter, and naming it is better than silently filtering
# on a field nobody has. Either way nothing is polluted — the point is that the
# response is deliberate.
is "proto pollution rejected cleanly" "$(code --get --data-urlencode '__proto__[x]=1' "$U/v1/posts")" "400"
is "constructor[prototype] handled" "$(code --get --data-urlencode 'constructor[prototype][x]=1' "$U/v1/posts?_limit=1")" "200"

echo; echo "WRITES"
W=$(curl -sD - --max-time 25 -X POST "$U/v1/posts" -H 'content-type: application/json' -d '{"title":"t"}')
has "echoed write says not-persisted" "$(echo "$W" | tr 'A-Z' 'a-z')" "x-mock-write"
is "sandbox without key is 403" "$(code -X POST "$U/v1/sandbox")" "403"
is "bad key is 401" "$(code "$U/v1/posts" -H 'authorization: Bearer flk_nope')" "401"
is "bad email is 400" "$(code -X POST "$U/v1/keys" -H 'content-type: application/json' -d '{"email":"nope"}')" "400"

echo; echo "ADMIN"
is "no token 401" "$(code "$U/v1/admin/stats")" "401"
is "wrong token 401" "$(code "$U/v1/admin/stats" -H 'authorization: Bearer wrong')" "401"
is "export needs token" "$(code "$U/v1/admin/export?dataset=daily")" "401"
if [ -n "$ADMIN" ]; then
  is "stats with token" "$(code "$U/v1/admin/stats" -H "authorization: Bearer $ADMIN")" "200"
  is "csv with token" "$(code "$U/v1/admin/export?dataset=countries" -H "authorization: Bearer $ADMIN")" "200"
  is "bad dataset 400" "$(code "$U/v1/admin/export?dataset=nope" -H "authorization: Bearer $ADMIN")" "400"
fi

echo; echo "CUSTOM APIs"
CID=$(curl -s --max-time 25 -X POST "$U/v1/custom" -H 'content-type: application/json' \
  -d '{"widgets":[{"id":1,"name":"a"},{"id":2,"name":"b"}]}' | sed -n 's/.*"id":"\([a-f0-9]\{16\}\)".*/\1/p')
[ -n "$CID" ] && ok "created a custom API" || bad "create" "no id returned"
if [ -n "$CID" ]; then
  is "reads it back"        "$(curl -s --max-time 25 "$U/v1/custom/$CID/widgets" | grep -c '"name":"a"')" "1"
  is "filters it"           "$(curl -s --max-time 25 "$U/v1/custom/$CID/widgets?name=b" | grep -c '"id":2')" "1"
  is "chaos applies to it"  "$(code "$U/v1/custom/$CID/widgets?_status=503")" "503"
  is "validates on it"      "$(code "$U/v1/custom/$CID/widgets?_status=999")" "400"
  is "exports json-server"  "$(code "$U/v1/custom/$CID/export?format=json-server")" "200"
  is "exports msw"          "$(code "$U/v1/custom/$CID/export?format=msw")" "200"
  is "unknown resource 404" "$(code "$U/v1/custom/$CID/nope")" "404"
fi
is "rejects invalid JSON"   "$(code -X POST "$U/v1/custom" -H 'content-type: application/json' -d '{oops')" "400"
is "rejects arrayless JSON" "$(code -X POST "$U/v1/custom" -H 'content-type: application/json' -d '{"a":1}')" "400"

echo; echo "CORS"
is "preflight 204" "$(code -X OPTIONS "$U/v1/posts")" "204"
has "allow-origin *" "$(curl -sD - -o /dev/null --max-time 25 -X OPTIONS "$U/v1/posts" | tr 'A-Z' 'a-z')" "access-control-allow-origin: \*"

echo
printf "── \033[32m%d passed\033[0m, \033[31m%d failed\033[0m\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
