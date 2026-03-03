# Bittery Security-Hardening Analyse (Ist-Stand + Lösungsweg)

## Auftragsscope
Diese Analyse deckt die aktuell gesichtete Codebase ab, mit Fokus auf:
- Rust Crypto Core (`packages/crypto/core/crates/bittery-crypto-core`)
- WASM/NAPI/FFI/Expo/Tauri Bindings
- TypeScript Core Services (Item/Vault/Auth)
- tRPC Auth/Sync/Vault Routen
- Sync-Events Schema und Delta-Sync

Wichtig: Diese Datei enthält **nur Findings + Lösungsweg**. Es wurden hier bewusst **keine Implementierungen** vorgenommen.

---

## Executive Summary

### Kritisch 1: Fehlende AAD-Context-Bindung bei AES-GCM
Aktuell wird AES-256-GCM ohne AAD-Kontext verwendet. Dadurch kann ein kompromittierter Server verschlüsselte Blobs zwischen Entitäten austauschen (z. B. zwischen Items/Vaults/Accounts), ohne dass der Client dies kryptografisch erkennt.

### Kritisch 2: Kein KDF-Parameter-Pinning im Login-Flow
Der Login-Flow vertraut aktuell servergelieferten SRP/KDF-relevanten Parametern (insb. Salt) ohne lokale Pinning-Validierung. Es gibt derzeit keine persistierte Client-Pin-State-Logik, die serverseitige Downgrade-/Manipulationsversuche erkennt.

---

## Was bereits vorhanden ist (positiv)
- Robuste Primitive sind vorhanden: AES-GCM, PBKDF2, HKDF, SRP-6a, RSA.
- `derive_keys` im Rust-Core nutzt PBKDF2 + HKDF mit festen Iterationen (`310_000`) für den Master-Key-Pfad.
- SRP auf Server/Client ist konsistent auf SHA-256 + 4096-Gruppe ausgelegt.
- Item-Versionierung und Konflikterkennung (`expectedVersion`) existieren serverseitig.
- Sync-Events enthalten bereits `vaultId`, `entityId`, `entityType`, `version`, `userId` (wichtige Kontextdaten für AAD).

---

## Detail-Findings

## 1) AES-GCM ohne AAD (High)

### Ist-Zustand
- Rust-Core `encryption.rs`: `encrypt(plaintext, key)` / `decrypt(encrypted_data, key)` ohne AAD.
- Algorithmus-Feld ist derzeit faktisch `"AES-GCM"`.
- Decrypt prüft keinen Kontext (Vault/Entity/User/Version).
- Plattform-Adapter (WASM/Tauri/Expo/FFI) reichen keinen Kontext mit.
- TS-Services (`item-service`, `vault-repository`, `use-item-attachments`, `share-service`, `vault-service`) verschlüsseln/entschlüsseln ohne Kontextbindung.

### Risiko
- Ciphertext-Swap/Replay zwischen Entitäten ist möglich, wenn der Server kompromittiert ist.
- Integrität gilt nur für „Ciphertext+IV“, nicht für semantische Zugehörigkeit.

### Betroffene zentrale Stellen
- `packages/crypto/core/crates/bittery-crypto-core/src/encryption.rs`
- `packages/core/src/services/item-service.ts`
- `packages/core/src/services/vault-repository.ts`
- `packages/core/src/hooks/use-item-attachments.ts`
- `apps/web/src/lib/wasm-crypto.ts`, `apps/extension/src/lib/wasm-crypto.ts`, `apps/desktop/src/lib/tauri-crypto.ts`, `apps/mobile/src/lib/crypto/native-crypto.ts`
- Bindings: `bittery-crypto-wasm`, `bittery-crypto-ffi`, Tauri `crypto_commands.rs`, Expo Module

---

## 2) KDF-Parameter-Pinning fehlt (High)

### Ist-Zustand
- `startLogin` liefert aktuell `salt` + `serverPublicKey` (kein explizites KDF-Param-Objekt).
- Client validiert keine serverseitige KDF-Policy gegen lokale Mindestanforderungen.
- Es gibt keine persistierte „first seen“ KDF-Pin-Struktur im Storage-Interface.
- SRP-Client nutzt `deriveSafePrivateKey` mit optionalen Iterationen; Login-Pfad übergibt keine strikte Policy/Pin-Prüfung.

### Risiko
- Ein kompromittierter Server kann Login-Parameter manipulieren (insb. Salt/Iteration in zukünftigen Erweiterungen), ohne dass der Client das als Downgrade/Manipulation erkennt.

### Betroffene zentrale Stellen
- `packages/api/src/routers/auth.ts` (`startLogin`, `finishLogin`, `quickUnlock`)
- `packages/auth/src/index.ts` (SRP challenge intern)
- `packages/core/src/services/auth-service.ts` (Login/Unlock-Handshake)
- `packages/types/src/index.ts` (`SRPServerChallenge`, `ICrypto`)
- Storage-Adapter-Interface + Implementierungen (web/chrome/tauri/react-native)

---

## 3) Kontextdaten sind vorhanden, aber kryptografisch ungenutzt (Medium)

### Ist-Zustand
- Sync/Event- und Item-Modelle liefern bereits relevante Felder:
  - `vaultId`, `entityId`, `entityType`, `version`, `userId`
- Diese Daten werden aktuell nicht als AAD gebunden.

### Chance
- Gute Ausgangslage für schnelle Einführung von AAD-Binding ohne große Datenmodell-Umstellung.

---

## Vorgeschlagener Lösungsweg (ohne Implementierung)

## Phase 1: AAD Context Binding im Rust-Core
1. Neue `AadContext` Struktur im Core einführen mit Feldern:
   - `vault_id`, `entity_id`, `entity_type`, `version`, `user_id`
2. Deterministische Serialisierung definieren:
   - feste Reihenfolge
   - `NUL`-Separator (`\0`) zwischen Feldern
3. Neue encrypt/decrypt-Varianten mit AAD ergänzen.
4. Algorithmuskennzeichnung für neue Payloads setzen (z. B. `AES-GCM-AAD-V1`).
5. Legacy-Decrypt für Alt-Daten (`AES-GCM`) beibehalten, damit Bestandsdaten nicht brechen.

## Phase 2: Bindings und TS-Interface durchziehen
1. `ICrypto.encrypt/decrypt` um optionalen Kontextparameter erweitern.
2. Kontextparameter durch WASM/Worker/Tauri/FFI/Expo JNI/Swift/Kotlin durchreichen.
3. Alle Item-/Attachment-/Vault-bezogenen Encrypt/Decrypt-Callsites auf Kontextbetrieb umstellen.

## Phase 3: Kontextquellen im App-Layer standardisieren
1. Zentralen Context-Builder in TS bereitstellen (einheitliche Erzeugung).
2. Für jeden Entitätstyp klare Mapping-Regel definieren:
   - Item: echte IDs/Version/User
   - Attachment: stable entity key (z. B. `attachment:{id}:name` / `...:contentType`)
   - Vault-Key/private key: definierte System-Entity-IDs
3. Bei Decrypt strikt denselben Kontext rekonstruieren.

## Phase 4: KDF-Policy + Pinning im Rust-Core
1. Core-Modul für KDF-Policy-Validierung einführen (`kdf_policy`):
   - hardcoded Mindestwerte (Iterations/Memory/Parallelism/Salt-Length je Algorithmus)
2. API-Funktion bereitstellen:
   - `validate_server_kdf_params(server_params, pinned_params?)`
3. Pinning-Regeln:
   - Algorithmus darf nicht herabgestuft werden
   - Iterations/Memory/Parallelism dürfen nur steigen (nie sinken)
   - Salt darf sich nach Erst-Pin nie ändern

## Phase 5: Auth-Flow + Storage anpassen
1. `startLogin` um explizites `kdfParams`-Objekt erweitern.
2. `auth-service` ruft vor SRP-Ableitung die Rust-Policy-Prüfung auf.
3. Beim ersten erfolgreichen Login: Params lokal pinnen.
4. Bei Folge-Logins: gegen Pin validieren, bei Verstoß hart fehlschlagen.
5. Storage-Interface um `getPinnedKdfParams/storePinnedKdfParams` erweitern, Implementierung für:
   - Web
   - Chrome Extension
   - Desktop (Tauri)
   - Mobile (React Native)

## Phase 6: Tests (Pflicht)

### Rust-Core Tests
- AAD Roundtrip erfolgreich bei identischem Kontext
- Decrypt schlägt fehl bei geändertem `vaultId/entityId/entityType/version/userId`
- Deterministische AAD-Serialisierung (stabile Bytefolge)
- Legacy-Daten bleiben entschlüsselbar (Backward-Compatibility)
- KDF-Policy: Mindestwerte werden erzwungen
- KDF-Pinning: Downgrade/Salt-Änderung wird abgelehnt

### TS/Integration Tests
- Ciphertext-Swap zwischen zwei Items führt zu Decrypt-Fehler
- Item-Move/Re-encrypt nutzt neuen Kontext korrekt
- Login bricht bei manipulierten KDF-Parametern ab
- Erstlogin speichert Pin, Folge-Login verifiziert Pin

---

## Priorisierte Umsetzung
1. Rust-Core AAD + KDF-Policy APIs
2. Binding-Durchleitung (WASM/Tauri/FFI/Expo)
3. TS-Service-Callsites für Item/Vault/Attachment auf Kontext umstellen
4. Auth `startLogin` + lokale KDF-Persistenz + Pinning
5. Vollständige Testsuite

---

## Offene Architekturentscheidungen (vor Umsetzung festzurren)
1. Endgültiger Algorithmus-String für AAD-gebundene Payloads (`AES-GCM-AAD-V1` empfohlen).
2. Umgang mit Legacy-Daten:
   - Nur Legacy-Decrypt erlauben
   - Optional später aktive Re-Encryption/Migration
3. Exaktes KDF-Param-JSON-Schema (versionierbar, plattformübergreifend stabil).
4. Welche Nicht-Item-Daten zwingend ebenfalls Kontextbindung erhalten sollen (z. B. private key, vault key, recovery payload).

---

## Fazit
Die Codebase ist kryptografisch solide in den Grundbausteinen, aber es fehlen zwei entscheidende architektonische Schutzmechanismen gegen kompromittierte Server:
- **AAD-Context-Binding** für semantische Integrität
- **KDF-Parameter-Pinning** für Downgrade-/Manipulationsschutz im Login

Mit dem oben beschriebenen, phasenweisen Plan lassen sich beide Maßnahmen einführen, ohne bestehende Funktionalität abrupt zu brechen.
