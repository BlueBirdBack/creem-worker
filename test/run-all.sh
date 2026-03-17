#!/bin/bash
# Run all creem-worker tests
cd "$(dirname "$0")/.."

echo "🧪 creem-worker test suite"
echo ""

PASS=0
FAIL=0

for f in test/*.test.ts; do
  echo "── $(basename "$f") ──"
  if node --experimental-transform-types --test "$f" 2>&1 | tail -3; then
    ((PASS++))
  else
    ((FAIL++))
  fi
  echo ""
done

echo "════════════════════════"
echo "Files: $((PASS + FAIL)) | Pass: $PASS | Fail: $FAIL"
[ $FAIL -eq 0 ] && echo "✅ All tests passed" || echo "❌ $FAIL file(s) failed"
exit $FAIL
