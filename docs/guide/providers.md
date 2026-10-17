# Connecting your mailbox — provider guide

Run `inbox-warden setup` and enter your email address. Setup recognises most providers automatically, tests the connection before it saves anything, and stores passwords and sign-ins in your operating system's keychain (Windows Credential Manager, macOS Keychain, Linux Secret Service) — never in a file.

Check everything at any time with `inbox-warden doctor`.

This page lists what you may have to do **at your provider** before setup succeeds.

| Provider | How you sign in | What to prepare |
|---|---|---|
| Gmail (personal) | App password | 2-Step Verification on, create an app password |
| Google Workspace | Google sign-in in the browser | Administrator creates an internal OAuth client (once) |
| Microsoft 365 / Exchange Online (preview) | Microsoft sign-in in the browser | Administrator registers the app and allows SMTP sending (once) |
| Outlook.com, Hotmail, Live (preview) | Microsoft sign-in in the browser | App registration that allows personal accounts |
| iCloud Mail | App-specific password | Create it at Apple |
| Yahoo Mail | App password | Create it at Yahoo |
| GMX, WEB.DE | Password (app-specific password with 2FA) | Turn on "POP3/IMAP Abruf" |
| Telekom (t-online.de) | E-mail password | Use the separate e-mail password |
| IONOS, STRATO, mailbox.org, Posteo | Mailbox password | Nothing |
| Own server (Dovecot/Postfix, Mailcow, …) | Mailbox password | Encryption on port 993/465 or STARTTLS; see below for self-signed certificates |
| Proton Mail | Bridge password | Install and start Proton Mail Bridge |

## Gmail (personal account)

Google does not accept your normal password for mail programs.

1. Open <https://myaccount.google.com/security> and make sure **2-Step Verification** is on.
2. Open <https://myaccount.google.com/apppasswords>, enter a name such as `Claude Mail` and choose **Create**.
3. Copy the 16-character password (spaces do not matter) and paste it when setup asks for the app password.

Changing your Google password revokes all app passwords; run setup again afterwards. Help: <https://support.google.com/accounts/answer/185833>

## Google Workspace (organisation) — for the administrator

Personal Gmail apps need Google's verification for full mail access. Inside your own organisation an **internal** OAuth client avoids that.

1. In the Admin console, allow IMAP: **Apps → Google Workspace → Gmail → End User Access → POP and IMAP access**.
2. In <https://console.cloud.google.com/> select (or create) a project that belongs to your organisation.
3. **Google Auth Platform → Branding**: app name `imap-mcp`, support email. **Audience**: user type **Internal**.
4. **Data Access → Add or remove scopes**: add `https://mail.google.com/`.
5. **Clients → Create client**: application type **Desktop app**, name `imap-mcp`. Copy **Client ID** and **Client secret**.
6. Give both values to your users. In setup they choose **"With your Google account in the browser"** and paste them.

For a desktop client Google does not treat the client secret as confidential; setup stores it in the configuration file (readable only by the user).

## Microsoft 365 / Exchange Online — for the administrator

> **Preview.** The Microsoft sign-in is implemented and tested against simulated servers, but not yet against a real Microsoft 365 tenant. Please report problems.

Microsoft has switched off password logins for IMAP. Sending with a password (SMTP AUTH) becomes off-by-default for existing tenants in late December 2026. Use the Microsoft sign-in.

### A. Register the app (once per organisation)

Inbox Warden does not ship its own Microsoft client ID yet, so every organisation registers its own app. It stays in your tenant, under your rules (user assignment, Conditional Access).

1. Open <https://entra.microsoft.com> → **Applications → App registrations → New registration**.
2. Name `imap-mcp`; supported account types **Accounts in this organizational directory only**; redirect URI: platform **Public client/native (mobile & desktop)**, value `http://localhost`. Register.
3. **Authentication → Advanced settings → Allow public client flows: Yes** (needed for "sign in with a code on another device").
4. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**: `IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access`. Then **Grant admin consent for <organisation>**.
5. Copy **Application (client) ID** and give it to your users together with your domain (setup asks for "Anwendungs-ID (Client-ID)" and "Mandant").

If Conditional Access blocks the device code flow (recommended by Microsoft), users simply use the browser sign-in.

### B. Allow sending (SMTP AUTH) for each mailbox that sends

Security defaults and tenants created after January 2020 disable SMTP AUTH. Enable it per mailbox in PowerShell:

```powershell
Install-Module ExchangeOnlineManagement -Scope CurrentUser   # once
Connect-ExchangeOnline -UserPrincipalName admin@your-domain.example
Set-CASMailbox -Identity user@your-domain.example -SmtpClientAuthenticationDisabled $false
Get-CASMailbox -Identity user@your-domain.example | Format-List SmtpClientAuthenticationDisabled
```

`False` means sending is allowed. Sent mail is filed in "Sent Items" by Microsoft automatically. Help: <https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/authenticated-client-smtp-submission>

## Outlook.com, Hotmail, Live (personal Microsoft accounts)

**Preview.** Personal accounts also need the Microsoft sign-in. The app registration must allow personal accounts (supported account types **"… and personal Microsoft accounts"**); setup uses the tenant `consumers` automatically. Inbox Warden does not ship such a registration yet, so for now this needs an app registered in an Entra directory you control.

## iCloud Mail

1. Sign in at <https://account.apple.com> → **Sign-In and Security → App-Specific Passwords → Generate**.
2. Name it `Claude Mail`, copy the password and paste it in setup.

Two-factor authentication must be on. Help: <https://support.apple.com/en-us/102654>

## Yahoo Mail

Open **Account security → Generate app password** (<https://help.yahoo.com/kb/SLN15241.html>), name it `Claude Mail`, paste it in setup.

## GMX and WEB.DE

1. Log in to the webmail, open **Einstellungen → POP3/IMAP Abruf** and turn on **"POP3 und IMAP Zugriff erlauben"**.
2. If two-factor login is on, create an **anwendungsspezifisches Passwort** and use it in setup.

At WEB.DE the login name is the part of the address before "@"; setup handles that. Help: <https://hilfe.gmx.net/pop-imap/einschalten.html>, <https://hilfe.web.de/pop-imap/einschalten.html>

## Telekom (t-online.de, magenta.de)

Use the separate **E-Mail-Passwort** from the Telekom Kundencenter, not your Telekom login password: <https://www.telekom.de/hilfe/festnetz-internet-tv/e-mail/e-mail-passwort>

## IONOS, STRATO, mailbox.org, Posteo

Use the mailbox password. IONOS only accepts sender addresses of your own domain.

## Your own mail server (Dovecot/Postfix, Mailcow, …)

- **Encryption is mandatory.** Use port 993 (IMAP) and 465 (SMTP), or 143/587 with STARTTLS. If the server offers neither, setup refuses to connect — otherwise the password would travel in clear text.
- **Best: a real certificate** (for example Let's Encrypt). Then nothing else is needed.
- **Self-signed certificate:** setup shows the certificate (issued to, issuer, validity, SHA-256 fingerprint) and asks whether to trust exactly this certificate. Compare the fingerprint on the server first:

  ```bash
  # Dovecot (path differs per distribution; see ssl_cert in dovecot.conf)
  openssl x509 -in /etc/dovecot/private/dovecot.pem -noout -fingerprint -sha256
  # Mailcow
  openssl x509 -in data/assets/ssl/cert.pem -noout -fingerprint -sha256
  ```

  Only confirm in setup if both fingerprints are identical. When you renew the certificate, run `inbox-warden setup` again; until then the connection is refused with "the server presented a different certificate", which also protects you against interception.
- Setup reads `https://autoconfig.<your-domain>/mail/config-v1.1.xml` if you publish one (Mailcow does), so users only need to type their address.

## Proton Mail

Install and start **Proton Mail Bridge** (<https://proton.me/mail/bridge>). In setup use the **Bridge password** shown in the Bridge app. The Bridge uses a self-signed certificate on `127.0.0.1`; trust it when setup asks.

## Privacy note on auto-detection

To find the server settings, setup looks up your domain's MX records and asks `autoconfig.<your-domain>` and Mozilla's `autoconfig.thunderbird.net` for the domain (never the password). Set `IMAP_MCP_NO_AUTOCONFIG=1` to switch these lookups off and enter the servers yourself.

## Troubleshooting

`inbox-warden doctor` explains each problem. The most common ones:

| Message | Fix |
|---|---|
| "Login rejected … requires an app password" | Create an app password (see your provider above). |
| "POP3/IMAP Abruf" mentioned | Turn on IMAP access in the GMX/WEB.DE settings. |
| "SMTP sending disabled for this mailbox" | Administrator runs `Set-CASMailbox … -SmtpClientAuthenticationDisabled $false`. |
| "no longer accepts password logins" | Choose the Microsoft sign-in in setup. |
| "The sign-in … is no longer valid" | `inbox-warden setup` → **Sign in again**. |
| "certificate … not signed by a known authority" | Compare fingerprints and trust the certificate in setup (own server only). |
| "presented a different certificate" | Certificate was renewed — run setup again; if you did not renew it, contact your administrator. |
| "offers no encryption (STARTTLS)" | Use port 993/465 or enable TLS on the server. |
| "credential store could not be used" (Linux) | Install and unlock gnome-keyring or KWallet, or pass secrets as environment variables. |
