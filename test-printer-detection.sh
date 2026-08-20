#!/bin/bash
# Quick test script to verify Tauri printer detection

echo "🔍 Testing Tauri Printer Detection"
echo "=================================="
echo ""

# Resolve app binary
APP_CMD=""
if command -v handy-pos >/dev/null 2>&1; then
    APP_CMD="handy-pos"
elif [ -x "src-tauri/target/release/handy-pos" ]; then
    APP_CMD="$(pwd)/src-tauri/target/release/handy-pos"
elif [ -x "src-tauri/target/debug/handy-pos" ]; then
    APP_CMD="$(pwd)/src-tauri/target/debug/handy-pos"
fi

# Check if app is running (binary name is handy-pos for local builds)
if pgrep -x "handy-pos" >/dev/null; then
    echo "✅ App is already running"
elif [ -n "$APP_CMD" ]; then
    echo "❌ App is not running. Starting: $APP_CMD"
    "$APP_CMD" > /tmp/handy-pos.log 2>&1 &
    sleep 3
    if pgrep -x "handy-pos" >/dev/null; then
        echo "✅ App is running"
    else
        echo "⚠ App failed to start (check /tmp/handy-pos.log)"
    fi
else
    echo "⚠ App binary not found (install package or build in src-tauri)"
fi
echo ""

# Check USB printer
echo "🖨️ Checking USB Printer..."
LSUSB_LINE=$(lsusb 2>/dev/null | grep -i "04b8:0202" | head -n 1)
if [ -n "$LSUSB_LINE" ]; then
    echo "$LSUSB_LINE"
    echo "✅ Printer detected via lsusb"
else
    if ! lsusb >/dev/null 2>&1; then
        echo "⚠ lsusb failed (likely permission/sandbox issue)"
    fi
    echo "❌ Printer not found"
fi
echo ""

# Check device permissions
echo "🔐 Checking Device Permissions..."
if [ -n "$LSUSB_LINE" ]; then
    BUS=$(echo "$LSUSB_LINE" | awk '{print $2}')
    DEV=$(echo "$LSUSB_LINE" | awk '{print $4}' | tr -d ':')
    DEV_PATH="/dev/bus/usb/$BUS/$DEV"
    ls -la "$DEV_PATH" 2>/dev/null && echo "✅ Device permissions OK" || echo "❌ Device node not accessible: $DEV_PATH"
else
    echo "⚠ Skipped (printer not detected above)"
fi
echo ""

# Check user group
echo "👤 Checking User Group..."
groups $USER | grep -q "lp" && echo "✅ User in lp group" || echo "❌ User not in lp group"
echo ""

# Check udev rules
echo "📋 Checking udev Rules..."
[ -f /etc/udev/rules.d/99-thermal-printers.rules ] && echo "✅ udev rules installed" || echo "❌ udev rules not found"
echo ""

echo "📝 To test printer detection:"
echo "1. Open the app (if not already open)"
echo "2. Go to Settings → Printers"
echo "3. Click 'Scan for Printers'"
echo "4. Check browser console (F12) for debug logs"
echo ""

echo "🔍 Debug logs:"
echo "tail -f /tmp/handy-pos.log"
