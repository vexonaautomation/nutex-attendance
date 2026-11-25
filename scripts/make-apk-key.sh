#!/usr/bin/env bash
# Run ONCE, from the repository folder, in Git Bash:  bash scripts/make-apk-key.sh
# Creates the APK signing key in C:/secrets, stores it as two GitHub Actions secrets and writes the website's
# assetlinks.json (that file is public: it only holds the certificate fingerprint) so the app opens without an address bar.
# KEEP C:/secrets/nutex-apk.p12 and its password safe: without them an installed app can never be updated.
set -euo pipefail
export MSYS_NO_PATHCONV=1
DIR=C:/secrets
mkdir -p "$DIR"
if [ ! -f "$DIR/nutex-apk.p12" ]; then
  openssl rand -hex 16 | tr -d '\r\n' > "$DIR/nutex-apk-password.txt"
  openssl req -x509 -newkey rsa:2048 -sha256 -days 10000 -nodes -keyout "$DIR/nutex-apk.key.tmp" -out "$DIR/nutex-apk.crt" -subj "/CN=NUTEX Attendance/O=NUTEX"
  openssl pkcs12 -export -inkey "$DIR/nutex-apk.key.tmp" -in "$DIR/nutex-apk.crt" -name nutex -out "$DIR/nutex-apk.p12" -passout "file:$DIR/nutex-apk-password.txt"
  rm -f "$DIR/nutex-apk.key.tmp"
fi
base64 -w0 "$DIR/nutex-apk.p12" | gh secret set ANDROID_KEYSTORE_B64
gh secret set ANDROID_KEYSTORE_PASSWORD < "$DIR/nutex-apk-password.txt"
FP=$(openssl x509 -in "$DIR/nutex-apk.crt" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d '\r\n')
mkdir -p apps/web/public/.well-known
printf '[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":"com.nutex.attendance","sha256_cert_fingerprints":["%s"]}}]\n' "$FP" > apps/web/public/.well-known/assetlinks.json
echo "Done. Next: git add apps/web/public/.well-known/assetlinks.json && git commit -m 'Android app link' && git push"
