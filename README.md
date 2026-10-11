# VOTION CLOUD Employee Hub

The employee hub uses Node.js 18 or newer and MySQL 8.0 or newer. Profiles, work items, shared conversations, attendance, time-off requests, expenses, calendar events, invitations, and sessions are stored on the server in MySQL. The browser does not store employee records in local storage.

## Run on Windows with native MySQL

Install MySQL Server 8.0 or newer (for example, `winget install --id Oracle.MySQL --exact`), initialize its data directory, and run it as a Windows service. Create an empty database and a dedicated MySQL user for this app. Copy `.env.example` to `.env`, set `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, and the initial admin values, then run:

```powershell
npm ci
npm start
```

The server applies its schema at startup. It listens on `HOST` (default `127.0.0.1`) and `PORT` (default `8000`). Set `DB_TLS=true` for a TLS connection to MySQL. `DATABASE_URL` can be used instead of the individual `DB_*` variables. Keep `.env` private and do not commit it.

## Accounts and workspace use

- The first admin account is bootstrapped from `INITIAL_ADMIN_*` when the database has no users.
- Admins can create seven-day, single-use employee invitation links from **People**. Share the link directly; the app does not send email.
- Admins can issue one-hour, single-use password reset links from an employee's directory card. Employees can also change their own password from their profile. Reset links must be shared privately.
- Passwords must be at least 12 characters. Sessions are held server-side and use an HttpOnly, SameSite=Strict cookie. Failed logins are rate limited.
- Employees can edit their profile, submit time-off/expense requests, check in/out once per UTC day, create work items, update item status, send shared channel messages, and view the directory/calendar.
- Admins can review or reject requests, manage invitations, and publish/delete calendar events.
- MySQL stores timestamps in UTC. Configure your organization’s timezone and policies before relying on attendance or HR workflows.

## Built-in audio and video calls

The **Calls** page supports separate one-to-one audio and video calls and separate group audio and video rooms. Teammates join the shared group rooms directly from that page. Calls require teammates to have VOTION CLOUD open; an unanswered direct call rings for 45 seconds. Group calls support up to eight participants.

Call invitations and WebRTC signaling run through this app’s authenticated WebSocket server. Audio/video travels directly between browsers and is not stored or recorded by VOTION CLOUD. No paid calling provider or calling subscription is used. The default free STUN server helps browsers discover a direct network path; it carries call setup only, not audio or video.

By default, the development server binds to `127.0.0.1`, so only this PC can open it. Browsers require HTTPS for microphone and camera access on other devices; `http://localhost` is allowed for local development only. To call teammates on other computers or phones, publish VOTION CLOUD on a network-accessible HTTPS address and configure the reverse proxy to pass WebSocket connections. Some firewalls and carrier networks block direct peer-to-peer media connections. For those networks, deploy a free, self-hosted TURN server such as coturn and set `WEBRTC_ICE_SERVERS` to a JSON array of its TURN server URL, username, and credential. These ICE settings are sent to signed-in browsers, so use short-lived TURN credentials for a public deployment. Calls and group-room membership are held in server memory and end when participants leave or the server restarts.

## Production deployment

Deploy behind a trusted HTTPS reverse proxy. Set `NODE_ENV=production`, and set `APP_ORIGIN` and `APP_BASE_URL` to the same public HTTPS origin. Production startup fails if these are missing or not HTTPS; session cookies are then marked Secure. Configure TLS for remote MySQL connections, use unique secrets from a secrets manager, restrict database/network access, and schedule encrypted MySQL backups and restore tests.

When using a reverse proxy, set `TRUST_PROXY=true` only if that proxy overwrites `X-Forwarded-For`. Do not expose the app directly to the internet over plain HTTP.

### Pterodactyl Node.js servers

Use a Node.js egg with Node.js 18 or newer and assign a server port in the panel. The app uses the `SERVER_PORT` allocation automatically and binds to `0.0.0.0` in that environment. Set the egg startup command to `npm start` and install the dependencies with `npm ci` (or configure the egg to run it during installation). Upload the project files without `.env`, `node_modules`, or local MySQL data; configure the variables from `.env.example` as private server environment variables in the panel instead.

The MySQL server must be reachable from the Pterodactyl container; `127.0.0.1` refers to the container itself, not a separate database server. For a production deployment, set `NODE_ENV=production`, set `APP_ORIGIN` and `APP_BASE_URL` to the same HTTPS website origin, and put the app behind a trusted HTTPS reverse proxy that supports WebSockets. Do not expose the app directly over plain HTTP.

For Proxmox monitoring, create a least-privilege read-only API token, use a trusted HTTPS certificate, and set `PROXMOX_URL`, `PROXMOX_TOKEN_ID`, and `PROXMOX_TOKEN_SECRET`. The token remains server-side; the dashboard reports a clear configuration state when it is absent.

## Tests

```powershell
npm test
```
