# The FLEETWISE Android app

Task B6, 19 November 2026. A Capacitor 8 app (`android/`, `capacitor.config.ts`) that opens the
hosted FLEETWISE app and adds what a web page cannot do: record a drive with the screen locked.
Everything else is the same app as in the browser, with the same sign-in and the same
permissions.

## What it does

| Area | In the app | Where |
|---|---|---|
| Opening FLEETWISE | The WebView opens `https://app.fleet-wise.co.za` (`server.url`). With no connection on first open it shows a local "needs a connection" page (`native/www/offline.html`). | `capacitor.config.ts` |
| Recording a drive | "Record my route" on a running drive (Driver activity, the trip's route card) starts the background-geolocation plugin's foreground service of type `location`. A notification shows the whole time. Recording continues with the screen locked or another app in front. It stops when the person taps Stop, when the server answers that the drive ended, the map is off or the business is stopped (409, 404, 402, 403, 400), and on sign-out. | `src/lib/native/recorder.ts`, `src/components/map/route-recorder.tsx` |
| Offline positions | Each drive has its own queue on the phone (localStorage, the person's id on it). Positions are sent every 30 seconds in batches of up to 200, through native HTTP (Android throttles a backgrounded WebView's requests after about five minutes). With no signal they wait, with backoff from 5 seconds up to 5 minutes. A day's worth at most is kept, the same limit the server uses. Signed out (401): the positions are kept until the same person signs in again. | `src/lib/native/position-queue.ts` |
| Gaps | A route is drawn and measured only where positions were recorded. A gap longer than 10 minutes, or a jump over 2 km needing more than 250 km/h, splits it. The distance across a gap is not counted, and a recording with gaps is not used to judge a trip over or under its plan. | `src/lib/map-data.ts` `routeSegments`, `src/lib/limits.ts` |
| Sign-out and another person | Signing out stops recording and deletes every queued position on the phone. When a different person signs in, whatever the last person left is deleted before anything is sent. | `src/components/assistant/sign-out-form.tsx`, `NativeSession` |
| Emailed links | Links to the app's own address (sign-in, invite, password reset) open inside the app once App Links are verified (below). Until then they open in the browser, as now. | `NativeLinks`, `android:autoVerify` |
| Other links | Links to any other site (Google Maps, Waze, Paystack, a supplier) open in the phone's browser or app. This is Capacitor's default. | `server.allowNavigation` left empty |
| Camera and files | File inputs open Android's own picker, which offers the camera. The app holds no camera permission. | Capacitor's WebView |
| Voice notes and spoken commands | The microphone works inside the app (`RECORD_AUDIO`), asked the first time it is used. | manifest |
| Push notifications | Not available in the app. Web push does not reach a WebView, and native push needs a Firebase project, which does not exist. The notification setting says so in the app; email and the in-app bell still work. | `src/components/push/push-toggle.tsx` |
| Back button, rotation | Capacitor's defaults: back goes back in the app's history, and rotation keeps the page. | |

## Decisions and trade-offs

- **The hosted address, not a bundled copy.** Capacitor's documentation says `server.url` is "intended for use with live-reload servers" and "not intended for use in production". FLEETWISE is server-rendered, and its forms post server actions, which cannot be exported as static files (docs/NATIVE_APP_AND_OFFLINE_PLAN.md section 2). So a bundled copy would be a second app. Consequences:
  - The app needs a connection to open.
  - An app update is needed only for native changes. Web changes reach the app on the next open.
  - Google Play may still review the app as a website wrapper. Its native purpose is drive recording.
- **The content security policy stays enforced.** On a WebView that supports document-start scripts, Capacitor adds its bridge outside the page, so the nonce-based policy is untouched and the WebView loads every request itself. On an older WebView, Capacitor would fetch pages itself, insert an inline script and drop the policy header. `android.minWebViewVersion: 100` sends those phones to the error page; the person updates "Android System WebView" from Play.
- **The legacy bridge.** The plugin's README says `android.useLegacyBridge: true` "prevents location updates halting after 5 minutes in the background". The cost is that the bridge is reachable from any frame in the page, not only the main one. The policy's `frame-src` decides which frames can load (today the captcha and the payment pages), and native requests still go only to the app's own address. Revisit if a frame from a new third party is added.
- **No background-location permission.** Recording runs in a foreground service the person starts while the app is open, with only "while in use" location, so `ACCESS_BACKGROUND_LOCATION` is removed from the merged manifest. A locked screen is fine; a drive that was never started is never recorded.
- **Backups off.** `allowBackup="false"` and data extraction rules exclude everything, so a session and queued positions never reach Google's backup or a new phone (POPIA).
- **The package name** `za.co.fleetwise.app` is permanent once published. Founder to confirm before the first upload.

## Build a debug app (local)

Needs Node 22 or later (the repo uses 24), the JDK that ships with Android Studio (`C:\Program Files\Android\Android Studio\jbr`), and the Android SDK (Android Studio installs it; or the command-line tools: platform `android-36`, platform-tools, build-tools 36).

```powershell
pnpm install
pnpm exec cap sync android
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
cd android
.\gradlew.bat assembleDebug
# android\app\build\outputs\apk\debug\app-debug.apk
```

`CAP_SERVER_URL=https://<preview address> pnpm exec cap sync android` points a test build at a preview deployment (sign-in cookies are per address). `-PappLinkHost=<host>` changes the App Links host for that build.

## Release build and Google Play

Everything here needs the founder: the Google Play developer account (in the business's name, with D-U-N-S number 588248857), the signing key, and a phone.

1. **Upload key.** `keytool -genkeypair -v -keystore fleetwise-upload.jks -alias upload -keyalg RSA -keysize 4096 -validity 10000`. Keep the file and both passwords in the password manager, never in the repository. Create `android/keystore.properties` (git-ignored) with `storeFile`, `storePassword`, `keyAlias` and `keyPassword`.
2. **Build the bundle.** `cd android; .\gradlew.bat bundleRelease` gives `app/build/outputs/bundle/release/app-release.aab`. Raise `versionCode` for every upload; `versionName` is what people see.
3. **Play Console, new app.** FLEETWISE; app; free; then upload the bundle to Internal testing first. Turn on Play App Signing (Google keeps the app signing key; yours is the upload key).
4. **App Links.** In Play Console, App integrity, copy the SHA-256 of the **app signing** certificate. Also copy the upload certificate's, for internal builds installed directly. Set both, comma-separated, as `ANDROID_CERT_SHA256` in Vercel Production, then redeploy. Check that `https://app.fleet-wise.co.za/.well-known/assetlinks.json` shows them. On the phone: `adb shell pm verify-app-links --re-verify za.co.fleetwise.app`, wait, then `adb shell pm get-app-links za.co.fleetwise.app` must say `verified`. On Android 15 and later, changes can take up to seven days to reach phones.
5. **Declarations** (Policy, App content):
   - **Foreground service** (`FOREGROUND_SERVICE_LOCATION`, for apps targeting Android 14 and later):
     - Description: "Records the route of a drive the driver starts, while the screen is locked, until they stop it or the drive ends."
     - Impact if deferred or interrupted: the drive's route has a gap; nothing is invented across it.
     - Use case: navigation or ride tracking.
     - A video showing the steps: sign in, open a drive, tap Record my route, see the notification, lock the screen, drive, unlock, tap Stop.
   - **Location permissions:** precise location while in use, for recording drives. Not background location.
   - **Data safety:**
     - Location (precise), collected, linked to the person, for app functionality; shared with nobody.
     - Name, email and phone, for the account.
     - Photos and audio only when the person attaches them.
     - Data is encrypted in transit, and people can ask for deletion (the app's account deletion and the Privacy notice).
   - **Privacy policy:** the app's Privacy page.
   - Content rating questionnaire; target audience adults; no ads.
6. **Prominent disclosure.** The words under "Record my route" (`map.nativeDisclosure`) say what is recorded, that it continues with the screen locked, that a notification shows, and how it stops. They are shown before the tap that brings up Android's location prompt.
7. **Store listing.** Short and full description, icon 512 x 512 (`public/icon-512.png`), feature graphic 1024 x 500, and at least two phone screenshots.

## Tests on a real phone (not done: needs the founder's phone and the Play account)

Install the debug app (`adb install -r app-debug.apk`), or later the Internal testing build. Then, with a test business on Complete and the map flag on, record each of these:

| Test | Expected |
|---|---|
| Start a drive, tap Record my route, allow location while in use | The notification "Recording your drive" appears; positions arrive (trip route card). |
| Lock the screen, drive 15 minutes, unlock | The route covers the locked time with no gap. |
| Put another app in front for 10 minutes | Same. |
| Deny location at the prompt | "Location is not allowed..." and the Open settings button; nothing recorded. |
| Revoke location in Settings while recording | Recording stops; the page says so on return. |
| Airplane mode for 5 minutes while recording, then back | Positions from the dead zone arrive afterwards; the count of waiting positions goes down. |
| Battery saver on, and the app's battery setting on Restricted | Record whether recording continues. Phone makers differ: some stop foreground services under aggressive saving. Write down make, model and Android version. |
| Stop the drive in the browser while the phone records | The phone stops on its next send ("this drive has ended"). |
| Sign out while recording | The notification goes; signing in as someone else sends nothing of the last person's. |
| Tap a password reset email link (after App Links are verified) | It opens in the app at the reset page. |
| Attach a photo with the camera, record a voice note | Both work. |
| Turn off "Android System WebView" updates on an old phone | Below version 100: the "needs a connection" page. Update the WebView. |

## iPhone

There is no iPhone app. On an iPhone FLEETWISE is the website, or the website added to the home screen (`/install`). Safari stops a page's location when the screen locks or the page is in the background, so a drive is recorded only while the page stays open and in front, and the recorder says so. Web push works for a home-screen app on iOS 16.4 or later. An App Store app that records in the background would be a separate project, with an Apple developer account, and is not promised.

## Not built

- Native push (Firebase Cloud Messaging): needs a Firebase project and the founder's decision.
- Files downloaded inside the app (CSV and PDF exports) depend on the WebView's download handling, which is not tested yet. On a phone where a download does nothing, use the website in the browser for exports.
- A full offline mode for the field screens (docs/NATIVE_APP_AND_OFFLINE_PLAN.md phase 1) is separate from this app.
