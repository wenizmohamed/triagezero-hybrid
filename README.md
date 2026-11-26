# TriageZero — Connectivity-Resilient Multi-Platform Hybrid AI Disaster Medical Triage

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Firebase AI Logic](https://img.shields.io/badge/Firebase_AI_Logic-Hybrid_Inference-orange.svg)](https://firebase.google.com/docs/ai-logic)
[![BuildHybridAI 2026](https://img.shields.io/badge/Google-%23BuildHybridAI_2026-DC2626.svg)](https://firebasehybridaihackathon.devpost.com/)
[![Devpost Submission](https://img.shields.io/badge/Devpost-TriageZero-003E54?style=flat&logo=devpost)](https://devpost.com/software/triagezero)
[![Live Web Workbench](https://img.shields.io/badge/Live_Web-Vercel-000000?logo=vercel)](https://triagezero-hybrid.vercel.app/)
[![Demo Video](https://img.shields.io/badge/Demo_Video-YouTube-FF0000?logo=youtube)](https://youtu.be/6m94TguioXw)

**TriageZero** is a multi-platform (**Web (Chrome) + Native Android**) offline-first emergency and mass-casualty medical triage platform powered by **Firebase AI Logic Hybrid Inference** (`ONLY_ON_DEVICE` / `PREFER_ON_DEVICE` <-> `ONLY_IN_CLOUD`).

- **Live Web ER Command Workbench (Chrome):** [https://triagezero-hybrid.vercel.app/](https://triagezero-hybrid.vercel.app/)
- **Native Android Field EMT Companion (`/android`):** Kotlin + Jetpack Compose app using `com.google.firebase:firebase-ai` (`InferenceMode.PREFER_ON_DEVICE`) for offline field triage synced live via zero-PHI Cloud Firestore into the Web ER Command Dashboard.
- **Devpost Submission:** [https://devpost.com/software/triagezero](https://devpost.com/software/triagezero)
- **YouTube Demo:** [https://youtu.be/6m94TguioXw](https://youtu.be/6m94TguioXw)

When earthquakes, highway pileups, or remote wilderness emergencies sever cellular networks, cloud-only AI stops working at the exact moment lives depend on it. **TriageZero** runs 100% on-device in disaster dead zones using Chrome Built-in AI (**Gemini Nano**) + a deterministic clinical **START (Simple Triage and Rapid Treatment)** RPM engine sealed into a tamper-evident **SHA-256 IndexedDB hash chain** (`0 B` cloud traffic). The instant Starlink or 5G connectivity returns, TriageZero flips its hybrid routing boundary to Firebase AI Logic **`ONLY_IN_CLOUD` (`gemini-3.5-flash-lite`)** to burst-synthesize **Multi-Casualty Hospital Surge Allocation**, automatic trauma-center diversion routing, **HL7 FHIR R4** bundles, and **Clinical SOAP** ER handoffs backed by zero-PHI Cloud Firestore dispatch receipts.

---

## Hybrid AI Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    DISASTER DEAD ZONE (OFFLINE)                         │
│  Chrome Built-in AI (Gemini Nano) · InferenceMode.ONLY_ON_DEVICE        │
│  + Clinical START RPM Engine (Walk -> Resp -> Perfusion -> Mental)      │
│  -> Tamper-Evident SHA-256 Hash Chain (IndexedDB + LocalStorage)        │
│  -> 0 B Cloud Traffic · <2ms Deterministic Clinical Triage              │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                    [ Connectivity Boundary Gate ]
               OFFLINE DEAD ZONE  <--->  STARLINK / 5G RESTORED
                                │
┌───────────────────────────────▼─────────────────────────────────────────┐
│                 CONNECTIVITY RESTORED (CLOUD SURGE)                     │
│  Firebase AI Logic · InferenceMode.ONLY_IN_CLOUD (gemini-3.5-flash-lite)│
│  + Lazy App Check (reCAPTCHA Enterprise) + Firebase Remote Config       │
│  -> Multi-Casualty Hospital Surge & Trauma Diversion Routing            │
│  -> HL7 FHIR R4 Collection Bundle (.json) + Clinical SOAP Handoff (.md) │
│  -> Zero-PHI Aggregate Dispatch Receipts in Cloud Firestore             │
└─────────────────────────────────────────────────────────────────────────┘
```

## Key Features

1. **1-Click Live Connectivity / Dead-Zone Simulator (`OFFLINE DEAD ZONE` <-> `STARLINK / 5G RESTORED`)** — Flip the hybrid routing boundary live and watch `ONLY_ON_DEVICE` (`0 B` cloud traffic) transition cleanly into `ONLY_IN_CLOUD` hospital surge synthesis with animated telemetry SVGs.
2. **Interactive START Clinical Decision Tree SVG + Real-Time Vital Sliders** — Adjust Respiratory Rate (`>30/min`), Capillary Refill (`>2.0s`), Radial Pulse, Airway Positioning, and Mental Status to recalculate `IMMEDIATE RED`, `DELAYED YELLOW`, `MINOR GREEN`, or `EXPECTANT BLACK` in `<2ms` with live decision-path illumination.
3. **5 Preloaded Disaster EMS Scenarios + 1-Click 6-Casualty Mass-Incident Burst** — Earthquake crush injury (`RED`), highway pediatric trauma (`RED`), warehouse smoke inhalation (`YELLOW`), perimeter walking wounded (`GREEN`), apneic unresponsive (`BLACK`), plus bus rollover airway rescue (`RED`). Run all 6 offline with `0 B` cloud traffic, then burst into a 4-hospital trauma diversion plan the instant connectivity restores.
4. **Interoperable HL7 FHIR R4 & Clinical SOAP Export** — LOINC-coded observations (`75636-1` START Category, `9279-1` Respiratory Rate, `44963-7` Capillary Refill) sealed with SHA-256 chain roots and 1-click `.json` / `.md` downloads.
5. **Hardened Zero-PHI `firestore.rules` + Live Hybrid Routing Audit Log** — Proves `inferenceSource` (`on-device` vs `in-cloud`), token savings, latency, zero dropped offline records, and server-side rejection of patient names or raw clinical notes at the Firestore rules boundary.

---

## Local Development & Verification

### Web Workbench (Chrome + Firebase AI Logic)

```bash
npm install
npm test        # Runs 40 deterministic Vitest clinical, crypto, surge, FHIR & security tests
npm run dev     # Launches Vite local dev server
npm run build   # Builds production bundle into dist/
```

### Android Field EMT Companion (`android/`)

```bash
cd android
./gradlew testDebugUnitTest assembleDebug
```

- Built with Kotlin + Jetpack Compose + `com.google.firebase:firebase-ai` (`InferenceMode.PREFER_ON_DEVICE`, `InferenceMode.ONLY_ON_DEVICE`, `InferenceMode.ONLY_IN_CLOUD`) + `firebase-ai-ondevice` + App Check + Remote Config + Cloud Firestore live sync.
- Field EMTs triage casualties offline on Android in disaster dead zones, then sync zero-PHI START tags (`/incidents/INC-TZ26-001/casualties/{tagId}`) live into the Chrome ER Web Workbench on reconnect.

## Firebase Setup

- `src/firebase.js` uses `firebase/ai` (`getAI`, `getGenerativeModel`, `GoogleAIBackend`, `InferenceMode.ONLY_ON_DEVICE`, `InferenceMode.ONLY_IN_CLOUD`, `InferenceMode.PREFER_ON_DEVICE`), lazy `initializeAppCheck` (zero boot-time beacons), `firebase/remote-config`, and `firebase/firestore`.
- `remoteconfig.template.json` defines live cloud model selection (`gemini-3.5-flash-lite`) and START protocol thresholds (`start_resp_rate_max`, `start_cap_refill_max_sec`).
- `firestore.rules` enforces append-only, zero-PHI aggregate dispatch receipts.

## License

Licensed under the [Apache License 2.0](LICENSE).
