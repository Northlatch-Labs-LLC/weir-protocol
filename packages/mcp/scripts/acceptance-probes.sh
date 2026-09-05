#!/usr/bin/env bash
# Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
#
# The seven acceptance probes for a hosted keyless weir-mcp.
# Run against the DEPLOYED URL before the DNS name is published; every probe prints its real
# answer and the script fails on the first one that is not what the shape promises.
#
#   usage: acceptance-probes.sh <base-url> <expected-host>
#   e.g.   acceptance-probes.sh https://mcp.weir.social mcp.weir.social
set -euo pipefail

BASE="${1:?base url, e.g. https://mcp.weir.social}"
HOST="${2:?the one Host this server answers to, e.g. mcp.weir.social}"
MCP="$BASE/mcp"
JSON='content-type: application/json'
ACCEPT='accept: application/json'
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"acceptance","version":"0"}}}'
LIST='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
READ_SET='weir_balance weir_quote weir_read weir_search'   # the read set; none of buy/subscribe/post/send/price
failures=0

probe() { # <label> <expected-status> <curl args...>
  local label="$1" want="$2"; shift 2
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@")
  if [ "$got" = "$want" ]; then echo "  ok  $label → $got"; else echo "FAIL  $label → $got (expected $want)"; failures=$((failures+1)); fi
}

echo "=== $MCP as $HOST ==="
# 1. DNS rebinding: any other Host is refused.
probe 'Host rebind.example is refused (403 host_refused)'      403 -X POST "$MCP" -H "Host: rebind.example" -H "$JSON" -d "$INIT"
# 2. A browser page: any Origin is refused while the allowlist is empty.
probe 'Origin https://evil.example is refused (403 origin_refused)' 403 -X POST "$MCP" -H "Origin: https://evil.example" -H "$JSON" -d "$INIT"
# 3. Cookies: refused, not ignored.
probe 'a Cookie is refused (400 cookie_refused)'               400 -X POST "$MCP" -H "Cookie: a=b" -H "$JSON" -d "$INIT"
# 4. Only /mcp exists.
probe 'GET / is 404'                                            404 "$BASE/"
# 5 + 6. A served response issues no cookie and no session id.
headers=$(curl -s -D - -o /dev/null --max-time 15 -X POST "$MCP" -H "$JSON" -H "$ACCEPT" -d "$INIT")
if echo "$headers" | grep -qi '^set-cookie:'; then echo 'FAIL  a served response set a cookie'; failures=$((failures+1)); else echo '  ok  no Set-Cookie on a served response'; fi
if echo "$headers" | grep -qi '^mcp-session-id:'; then echo 'FAIL  a served response issued a session id'; failures=$((failures+1)); else echo '  ok  no mcp-session-id on a served response'; fi
# 7. tools/list is exactly the read set: nothing that spends, writes or prices.
tools=$(curl -s --max-time 15 -X POST "$MCP" -H "$JSON" -H "$ACCEPT" -d "$LIST" | tr ',' '\n' | grep -o '"name":"weir_[a-z_]*"' | sed 's/"name":"//; s/"//' | sort | tr '\n' ' ' | sed 's/ $//')
if [ "$tools" = "$READ_SET" ]; then echo "  ok  tools/list is the read set: $tools"; else echo "FAIL  tools/list is [$tools], expected [$READ_SET]"; failures=$((failures+1)); fi

if [ "$failures" -gt 0 ]; then echo "$failures probe(s) failed"; exit 1; fi
echo 'all seven probes passed'
