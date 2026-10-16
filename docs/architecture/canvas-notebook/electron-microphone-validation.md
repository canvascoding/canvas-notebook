# Electron microphone validation on macOS

The desktop shell records dictation through the hosted web app's `getUserMedia`
and `MediaRecorder` flow. macOS consent and the signed app's capabilities are
separate requirements. An allowed microphone and a live media track do not prove
that a recording contains speech.

## Packaging requirements

Keep `com.apple.security.device.audio-input` enabled in both
`electron/build/entitlements.mac.plist` and
`electron/build/entitlements.mac.inherit.plist`. The latter also signs the helper
processes that host Chromium's audio service. Keep Hardened Runtime enabled.
The app's `NSMicrophoneUsageDescription` explains the dictation purpose.

`npm run test:electron` checks these source settings. After packaging, verify the
actual app and every helper, including their signatures and Hardened Runtime:

```sh
CANVAS_ELECTRON_MAC_TEST_BUNDLE="/absolute/path/Canvas Notebook.app" \
  node --test electron/main/microphone-packaging.test.mjs
```

The desktop build workflow runs this check before accepting its signed artifacts.
A development Electron process or a browser test cannot validate the packaged
app's entitlements. A server update alone cannot change an installed app's signed
capabilities; distribute a new desktop build for packaging fixes.

## Physical microphone acceptance

1. Use the packaged app and the same server/account as the browser comparison.
2. Confirm Canvas Notebook has access in System Settings → Privacy & Security →
   Microphone. If a previous denial was changed, quit and restart the app.
3. Open a MacBook's lid when using its built-in microphone, or choose a connected
   external microphone as the system input. Apple silicon and T2 Mac laptops
   disconnect the built-in microphone in hardware with the lid closed.
4. Speak a known sentence, finish dictation and confirm it is appended to the
   existing draft. Repeat several times and verify the input is released after
   each recording. Repeat after a microphone permission denial and recovery.
5. If speech is missing, inspect the local recording's duration, samples and
   audibility before attributing the failure to upload or transcription. A valid
   silent recording can produce `EMPTY_TRANSCRIPT` (HTTP 422).

Controlled audio injected through Chromium can verify recording, upload and
transcript insertion. Label it as controlled input; it does not replace the
physical microphone check. Speaker playback can also be removed by echo
cancellation, so a silent speaker-loopback test is not conclusive.

References: [Apple audio-input entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input),
[Electron microphone consent](https://www.electronjs.org/docs/latest/api/system-preferences#systempreferencesaskformediaaccessmediatype-macos),
[Apple hardware microphone disconnect](https://support.apple.com/en-ca/guide/security/secbbd20b00b/web).
