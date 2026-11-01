#!/bin/sh
# Runs the offline backend test with the JavaScript engine built into macOS.
cd "$(dirname "$0")/.." || exit 1
exec /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc tests/backend-test.js
