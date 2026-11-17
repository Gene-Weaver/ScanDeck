#!/bin/zsh
# Builds ScanDeck.app, a small launcher for the Electron app in this folder, and copies it to /Applications.
#   zsh launcher/make_launcher.sh            build + install
#   zsh launcher/make_launcher.sh --no-install   build only (launcher/ScanDeck.app)
# The launcher only starts Electron on this project folder, so app updates need no rebuild. If the project moves,
# run this again from the new place.
set -e
HERE="${0:A:h}"; PROJECT="${HERE:h}"; APP="$HERE/ScanDeck.app"
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# --- icon: the app's logo (teal tile, dark window, bright scan line) ---
ICON="$HERE/ScanDeck.png"
magick -size 1024x1024 xc:none \
  -fill '#2ec4b6' -draw 'roundrectangle 100,100 924,924 190,190' \
  -fill '#0d2b28' -draw 'roundrectangle 226,258 798,766 60,60' \
  \( -size 1024x1024 xc:none -fill '#e9fffb' -draw 'roundrectangle 226,474 798,506 14,14' -blur 0x26 \) -composite \
  -fill '#e9fffb' -draw 'roundrectangle 226,478 798,502 12,12' \
  "$ICON"
SET="$HERE/ScanDeck.iconset"; rm -rf "$SET"; mkdir "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ICON" --out "$SET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$ICON" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done

# --- the .app ---
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
iconutil -c icns "$SET" -o "$APP/Contents/Resources/ScanDeck.icns"; rm -rf "$SET"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>ScanDeck</string>
  <key>CFBundleDisplayName</key><string>ScanDeck</string>
  <key>CFBundleIdentifier</key><string>local.scandeck.launcher</string>
  <key>CFBundleExecutable</key><string>ScanDeck</string>
  <key>CFBundleIconFile</key><string>ScanDeck</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
cat > "$APP/Contents/MacOS/ScanDeck" <<LAUNCH
#!/bin/zsh
# Starts ScanDeck (Electron) from its project folder. A second launch just brings the running window forward.
PROJECT="$PROJECT"
ELECTRON="\$PROJECT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [[ ! -x "\$ELECTRON" ]]; then
  osascript -e "display alert \"ScanDeck\" message \"Could not find the app in \$PROJECT. If the folder moved, run launcher/make_launcher.sh again from the new place.\""
  exit 1
fi
unset ELECTRON_RUN_AS_NODE
export PATH="/opt/homebrew/bin:/usr/local/bin:\$PATH"
mkdir -p "\$HOME/Library/Logs/ScanDeck"
cd "\$PROJECT" && exec "\$ELECTRON" . >> "\$HOME/Library/Logs/ScanDeck/launcher.log" 2>&1
LAUNCH
chmod +x "$APP/Contents/MacOS/ScanDeck"
echo "built $APP"
if [[ "$1" != "--no-install" ]]; then
  rm -rf /Applications/ScanDeck.app && cp -R "$APP" /Applications/ScanDeck.app && touch /Applications/ScanDeck.app
  echo "installed /Applications/ScanDeck.app"
fi
