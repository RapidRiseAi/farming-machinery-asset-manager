# REPORT B6: the Android app

Lane B, branch `final/lane-b`, 19 November 2026, from `ca29985`. Built by the main Claude session (the founder ended subagents on 19 Nov). BRIEF section 8 "Android and device gaps" and the last paragraph of section 21; scenario 35 (device parts). Nothing was pushed to `main`, published, signed for release or applied to a live database by this work.

Gates at the final code commit: see section 8.

## 1. Done

| Part | What was built | Where |
|---|---|---|
| No route across a gap (a defect found) | `routeLine` joined every stored position into one line, so a dead zone or a locked screen was drawn as a straight line, and `lineKm` counted it as kilometres driven. Now `routeSegments` splits a route at a gap of more than 10 minutes, or at a jump of over 2 km that would need more than 250 km/h. The trip card and the map draw each piece separately and count only recorded distance, and they say how many gaps there were. A recording with gaps is no basis for "over" or "under" the plan. Off-route distance is measured piece by piece. | `src/lib/map-data.ts`, `src/lib/routing/geometry.ts` (`offRouteSegments`), trip route card, `/map`, limits `routeGapMs` and `routeJumpKm` |
| The Android project | Capacitor 8.6.2 (current major; min SDK 24, target and compile SDK 36). The app opens the hosted app at `https://app.fleet-wise.co.za` (`CAP_SERVER_URL` for a test build), with a local start page and a "needs a connection" error page. FLEETWISE icons and splash come from the app's own maskable icon. | `capacitor.config.ts`, `android/`, `native/www/` |
| Background recording | The background-geolocation plugin 1.3.1 runs a foreground service of type `location`, with a notification for as long as it records. It is started by the driver's explicit tap on a running drive. It stops on Stop; when the server answers that the drive ended, the map is off or the business is stopped; and on sign-out. It carries on after the app reopens. A refusal shows "location is not allowed" and a button to the app's settings. Before the tap, the words say what is recorded, that it continues with the screen locked, that a notification shows, and how it stops (Play's prominent disclosure). | `src/lib/native/recorder.ts`, `src/components/map/route-recorder.tsx`, `recorder-labels.ts` |
| Offline queue | One queue per drive on the phone, marked with the person's id. Every 30 seconds it sends batches of up to 200 to the existing `/api/positions`, through native HTTP; Android throttles a backgrounded WebView's requests, and native requests use the WebView's own sign-in cookies. With no signal it backs off from 5 s to 5 min. It keeps at most a day of positions, the server's limit; a 401 keeps them for the same person, and the drive-ended answers drop them. | `src/lib/native/position-queue.ts` |
| Session isolation | Sign-out stops recording and deletes every queued position. A different person signing in finds nothing of the last person's: it is deleted before anything is sent. Backups and device transfer are off for the whole app (`allowBackup="false"`, data extraction rules). | sign-out form, `NativeSession`, manifest |
| Permissions and policy | The merged manifest has fine and coarse location, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION` and `POST_NOTIFICATIONS` from the plugin, plus `RECORD_AUDIO` for voice notes. `ACCESS_BACKGROUND_LOCATION` is removed. The plugin's service is overridden to not exported. GPS, microphone and camera are optional hardware. There is no camera permission: Android's own picker takes photos. Cleartext is off. | `android/app/src/main/AndroidManifest.xml` |
| Deep links | App Links (`autoVerify`) for the app's host. Emailed sign-in, invite and reset links open inside the app at the same page, with the code. `/.well-known/assetlinks.json` is built from `ANDROID_CERT_SHA256` and stays empty until signing exists. | `NativeLinks`, `src/lib/native/links.ts`, `asset-links.ts` |
| External links, camera, files, voice | Other sites open in the phone's browser or apps (Capacitor's default). File inputs use the system picker with the camera; the microphone works for voice notes. | |
| Push | Honestly unavailable: web push does not reach a WebView and native push needs Firebase. The setting says so in the app. | `push-toggle.tsx` |
| CSP | Still enforced. With `minWebViewVersion: 100`, Capacitor adds its bridge as a document-start script, so the nonce policy is untouched and page requests are not proxied. Below 100, Capacitor would proxy pages and drop the policy, so those phones get the error page instead. Read from Capacitor's Android source (`Bridge.java`, `WebViewLocalServer.java`, `JSInjector.java`). | `capacitor.config.ts` |
| Build | `.github/workflows/android.yml` builds the debug APK on every change to the Android files and keeps it for 30 days as the artifact `fleetwise-android-debug`. It also checks the merged manifest: the foreground-service type and permission are present, there is no background location, the service is not exported, and backups are off. | workflow |
| Docs | `docs/ANDROID.md`: what the app does, the decisions and trade-offs, debug and release builds, the Play Console steps and declarations, the real-phone test list, iPhone limits, and what is not built. `docs/ROUTING.md` (recording in the app, gaps). `.env.example` (`ANDROID_CERT_SHA256`, `ANDROID_APP_ID`, names only). | |

Platform facts, read 19 Nov 2026:
- **Capacitor 8 update guide:** Node 22, AGP 8.13.0, Gradle 8.14.3, SDK 24 / 36 / 36.
- **Capacitor config docs:** `server.url` "not intended for use in production".
- **The plugin's README and manifest:** `useLegacyBridge`, native HTTP after five minutes, and no background permission.
- **Android:** a location foreground service needs `FOREGROUND_SERVICE_LOCATION` plus a location permission, and cannot be started from the background without background location. If `POST_NOTIFICATIONS` is denied, the service notice shows in Task Manager instead of the drawer.
- **Play Console:** the foreground service declaration asks for a description, the impact if deferred or interrupted, a video and a use case. Location use through a foreground service that is equivalent to background location is treated as background location.

## 2. Requirements and scenarios

| Covered | By |
|---|---|
| Scenario 35, device parts | Unit: `src/lib/native/native.test.ts` (queue ownership, age, cap, batches, outcomes, backoff; App Links paths; assetlinks; the manifest and config promises) and `src/lib/map-data.test.ts` (gaps, jumps, stray points, off-route per piece). CI: the debug build and merged-manifest checks. Real phones: the list in docs/ANDROID.md (external). |

Register: R-063 X (built; device tests and signing external). I-013 updated (D-U-N-S received; phones still needed).

## 3. Not done, and why

- **No real-phone tests.** Screen locked, backgrounded, permission denied or revoked, no network and battery saver all need a phone and the founder. The exact steps are in docs/ANDROID.md. Phone makers differ on battery saving; that is the largest unknown.
- **No local build artifact.** This machine reached Google's download servers at about 22 KB/s (npm: 675 KB/s), too slow for the SDK and Gradle's libraries. I started the SDK download, stopped it and removed the empty folders it had made. The debug APK is built in GitHub Actions instead. The local steps are in docs/ANDROID.md for a machine with a normal connection, or for Android Studio.
- **No release signing or store listing.** These need the founder's upload key and Play account.
- **No native push** (Firebase decision). **Downloads inside the app** (CSV and PDF exports) are not checked yet.

## 4. Assumptions (flag any that are wrong)

1. The package name `za.co.fleetwise.app`.
2. The app opens the hosted address rather than a bundled copy (see docs/ANDROID.md for why).
3. A gap is more than 10 minutes between positions, or a jump of over 2 km needing more than 250 km/h.
4. Recording needs only "while in use" location in a foreground service the driver starts; FLEETWISE never asks for background location.
5. The phone keeps at most a day of positions (the server refuses older ones) and at most 4,000.

## 5. Risks, most important first

1. **Battery savers.** Some phone makers stop foreground services under aggressive battery saving. Only a real-phone test shows which ones.
2. **The legacy bridge** is reachable from frames in the page. The CSP's `frame-src` limits which frames can load; revisit if a new third-party frame is added.
3. **Play review** may treat a hosted-address app as a website wrapper. The answer is the drive recording, which a website cannot do; it needs the foreground-service declaration and video.
4. **Native HTTP depends on cookies.** Native requests use the WebView's cookie store, which is Capacitor's own handler, read from its source. If a phone shows otherwise, a 401 keeps the positions until the app is in front again; nothing is lost within a day.

## 6. External blockers

| Blocker | Smallest human action |
|---|---|
| Play account | Open it in the business's name with D-U-N-S 588248857. |
| Signing and App Links | Make the upload key (docs/ANDROID.md step 1); turn on Play App Signing; set `ANDROID_CERT_SHA256` in Vercel. |
| Real phones | Run the test list in docs/ANDROID.md on at least one mid-range Android with the debug APK from the CI artifact. |
| Push | Decide whether to set up Firebase for native push. |

## 7. For the next tasks

- **A6 (release):** no migration in B6. The Android workflow runs at integration. Add the App Links variable to the release checklist. `ui:check` the trip card and `/map` for the gap note at 360 and 1024 px.
