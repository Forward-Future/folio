# Code signing

Folio's release build (`.github/workflows/release-build.yml`) signs automatically as soon as the secrets below exist in
the **Forward-Future/folio** repository (Settings → Secrets and variables → Actions, or `gh secret set NAME --repo
Forward-Future/folio`). Until then, macOS builds are ad-hoc signed and Windows builds are unsigned, which still work but
show a warning the first time they're opened.

## macOS: Apple Developer ID (signing + notarization)

What it fixes: no "can't verify the developer" block on first launch, and **Macs install updates automatically** (the
build sets `folioMacSigned`, which turns on silent updates in `electron/main.cjs`).

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/enroll/) (US$99/year). An organization
   enrollment needs a D-U-N-S number and shows the company name; an individual enrollment shows your name.
2. In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list), create a
   **Developer ID Application** certificate. On a Mac: Keychain Access → Certificate Assistant → Request a Certificate
   from a Certificate Authority, upload the request, download the certificate, and double-click it.
3. In Keychain Access, right-click the certificate → **Export** as `.p12` with a strong password.
4. Create an [app-specific password](https://account.apple.com) for your Apple ID (Sign-In and Security →
   App-Specific Passwords), and find your **Team ID** on the [membership page](https://developer.apple.com/account).
5. Add the secrets:

   ```sh
   base64 -i DeveloperID.p12 | gh secret set MAC_CERTIFICATE_P12_BASE64 --repo Forward-Future/folio
   gh secret set MAC_CERTIFICATE_PASSWORD --repo Forward-Future/folio      # the .p12 password
   gh secret set APPLE_ID --repo Forward-Future/folio                      # your Apple ID email
   gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo Forward-Future/folio
   gh secret set APPLE_TEAM_ID --repo Forward-Future/folio
   ```

The next `npm run release` produces a signed, notarized Mac app. Macs running an earlier, unsigned Folio still see the
"download" prompt once; after installing the signed version, updates are automatic.

## Windows: Azure Trusted Signing

What it fixes: no SmartScreen "Windows protected your PC" warning (reputation builds quickly for Trusted Signing
certificates), and Windows checks the publisher on every update.

1. In the [Azure portal](https://portal.azure.com), create a **Trusted Signing account** (Basic tier, about US$10/month)
   in a supported region, and note its **endpoint** (for example `https://eus.codesigning.azure.net`).
2. Complete **identity validation** (organization or individual). The validated name is the publisher Windows shows.
3. Create a **certificate profile** of type *Public Trust*.
4. Create an app registration (Microsoft Entra ID → App registrations), add a client secret, and give it the
   **Trusted Signing Certificate Profile Signer** role on the Trusted Signing account.
5. Add the secrets:

   ```sh
   gh secret set AZURE_TENANT_ID --repo Forward-Future/folio
   gh secret set AZURE_CLIENT_ID --repo Forward-Future/folio
   gh secret set AZURE_CLIENT_SECRET --repo Forward-Future/folio
   gh secret set AZURE_SIGNING_ENDPOINT --repo Forward-Future/folio     # e.g. https://eus.codesigning.azure.net
   gh secret set AZURE_SIGNING_ACCOUNT --repo Forward-Future/folio      # Trusted Signing account name
   gh secret set AZURE_SIGNING_PROFILE --repo Forward-Future/folio      # certificate profile name
   gh secret set AZURE_SIGNING_PUBLISHER --repo Forward-Future/folio    # exactly the validated publisher name
   ```

## Linux: apt repository key (already set up)

`APT_SIGNING_KEY` holds the private key that signs the apt repository published with every release; the public key is
`build/linux/folio-archive-keyring.gpg` and is installed by the `.deb`. Fingerprint:
`B337 6868 EE22 8389 6C2B  8ABD C455 276C CAE0 3757`.

The private key exists only in that GitHub secret. If it's ever lost or exposed, generate a new key, replace both the
secret and `build/linux/folio-archive-keyring.gpg`, and release: existing .deb users then install the new .deb once
from the releases page (apt will refuse the new signature until they do).
