# Deployment Guide

## Docker Deployment (Recommended)

### Production

```bash
# Clone and configure
git clone https://github.com/matthewdonsemail-lab/dialer.git
cd dialer
cp .env.example .env.local

# Configure environment
echo "TWENTY_BASE_URL=https://your-twenty-instance.com" >> .env.local
echo "TWENTY_API_KEY=your-api-key" >> .env.local
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env.local

# Optional: SIP configuration for softphone
echo "VITE_SIP_URI=sip:your-extension@your-domain.sip.signalwire.com" >> frontend/.env.local
echo "VITE_SIP_PASSWORD=your-password" >> frontend/.env.local
echo "VITE_SIP_WS_URL=wss://your-domain.sip.signalwire.com" >> frontend/.env.local
echo "VITE_SIP_CALLER_ID=+1XXXXXXXXXX" >> frontend/.env.local

# Build and start
docker compose up -d

# Access at http://localhost:3000
```

### Development

```bash
docker compose -f docker-compose.dev.yml up
```

## VPS Deployment

### Prerequisites
- Ubuntu 22.04+ or similar
- Docker and Docker Compose
- Domain name (optional)

### Steps

```bash
# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# Clone project
git clone https://github.com/matthewdonsemail-lab/dialer.git
cd dialer

# Configure
cp .env.example .env.local
nano .env.local  # Add your Twenty credentials

# Start
docker compose up -d
```

### Reverse Proxy (Nginx)

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
    }

    location /api {
        proxy_pass http://localhost:4000;
    }
}
```

## Hostinger Deployment

See [HOSTINGER_SETUP.md](../scripts/HOSTINGER_SETUP.md)

## Environment Variables

### Frontend (.env.local)
| Variable | Required | Description |
|----------|----------|-------------|
| VITE_API_URL | No | Backend API URL |
| VITE_SIP_URI | No | SIP registration URI |
| VITE_SIP_PASSWORD | No | SIP password |
| VITE_SIP_WS_URL | No | WebSocket URL for SIP |
| VITE_SIP_CALLER_ID | No | Outbound caller ID |

### Backend (.env.local)
| Variable | Required | Description |
|----------|----------|-------------|
| PORT | No | Server port (default: 4000) |
| JWT_SECRET | Yes | Secret for JWT tokens |
| TWENTY_BASE_URL | Yes | Your Twenty instance URL |
| TWENTY_API_KEY | Yes | Twenty API key |
| TWENTY_DATABASE_URL | Yes | PostgreSQL connection string |
| TELNYX_CALL_CONTROL_APP_ID | No | Telnyx Call Control application for phone audio and inbound routing |
| TELNYX_INBOUND_NUMBER | No | Telnyx business number to route through the Call Control application |
| TELNYX_AGENT_SIP_URI | No | SIP address to ring when an agent is registered; match `VITE_SIP_URI` |
| TELNYX_FALLBACK_PHONE | No | E.164 mobile to bridge only when no agent SIP heartbeat is active |
| TELNYX_HOLD_AUDIO_URL | No | Public HTTPS URL for the caller hold MP3 |

## SIP Configuration

To make real calls, configure your SIP provider in `frontend/.env.local`:

```env
VITE_SIP_URI=sip:your-extension@your-domain.sip.signalwire.com
VITE_SIP_PASSWORD=your-password
VITE_SIP_WS_URL=wss://your-domain.sip.signalwire.com
VITE_SIP_CALLER_ID=+1XXXXXXXXXX
```

See [SIP Providers Guide](sip-providers.md) for provider-specific setup.

### Telnyx inbound call fallback

To ring agents in the browser first and forward inbound callers to a mobile
only when no agent has explicitly gone online:

1. Configure a Telnyx Call Control application with the backend webhook URL
   (`/api/webhooks/telnyx?token=...`) and set its ID as
   `TELNYX_CALL_CONTROL_APP_ID`.
2. Assign the business number to that Call Control application and set it as
   `TELNYX_INBOUND_NUMBER`.
3. Set `TELNYX_AGENT_SIP_URI` to the same SIP identity as `VITE_SIP_URI`.
   Set `TELNYX_FALLBACK_PHONE` to the mobile in E.164 format.
4. Deploy `frontend/public/holding-for-guidance.mp3` with the frontend and set
   `TELNYX_HOLD_AUDIO_URL` to
   `https://<your-dialer-domain>/holding-for-guidance.mp3`.
5. Ensure the business number is authorized as outbound caller ID in Telnyx.
6. The business number must have an `agencyPhones` record before shared settings
   can be saved. Saving routing settings in the deployed app additively provisions
   its `agencyPhone.inboundRouting` RAW_JSON field using the backend's Twenty
   credentials; nothing needs to run locally. Operators may also provision it
   ahead of time with `bun run twenty:schema`.

Agents start **Offline** on sign-in or reload. Use **Inbound: Online/Offline**
in the dialer or **Settings → Inbound Calls** to receive calls in that browser.
Inbound is independent of **Settings → Outbound Audio**: selecting **Call me**
or **Dial in** for outbound calls does not change where inbound calls ring.
Going offline declines a pending inbound invitation but does not end an active
call or prevent outbound calls.

The browser reports a heartbeat every 20 seconds only while explicitly online
and actually SIP-registered; the UI shows Online only after the backend
acknowledges availability. Each browser session has its own presence record.
Normal offline changes release it immediately. If a browser closes or loses
connectivity without releasing it, presence expires within 60 seconds of its
last successful heartbeat. Availability failures are shown in the UI.
If any presence is live, Telnyx calls the configured SIP address; otherwise it dials the
fallback mobile. The outbound leg uses the inbound business number as caller
ID and bridges to the caller when the destination answers. While it rings, the
66-second MP3 plays on repeat for the caller and stops when the destination
answers. This applies only to inbound calls to `TELNYX_INBOUND_NUMBER`; it does
not fall back just because a registered agent misses the call.

**Settings → Inbound Calls** also lets authenticated workspace members save the
shared fallback mobile and public HTTPS hold-audio URL. These settings persist
in Twenty on the inbound business number and affect the entire workspace, not
just the current agent. Environment values remain the defaults until a saved
configuration exists. Store errors and invalid saved configurations are
reported rather than silently replaced with defaults. The fallback cannot be
the business number itself.

Browser SIP legs carry the original caller number in the
`X-Dialer-Original-Caller` header so the incoming-call UI and call log identify
the caller, not the business number used for the bridge. Mobile fallback legs
continue to present the business number as caller ID.

### Inbound caller matching

The incoming-call panel looks up the original caller in Twenty prospects, leads
and linked people, including additional numbers in PHONES fields. It shows the
matched name, company, job title and email where available, with a record link.
People open their company's contact page, where the People section lives.
Unknown callers remain answerable. Withheld caller IDs are not replaced with the
business number and are not looked up.

Numbers are normalized using their explicit calling code or the record's country
(for people, the linked company's country). National numbers without a known
country are not guessed. Twenty filters primary and additional phone candidates
server-side, then the backend verifies the full normalized international number;
matching a suffix alone never establishes identity.

A unique match associates an accepted call with its prospect or lead in history;
a matched person's call attaches to their company. Matching never delays answering,
so results arriving after answer still update the call and its record association.
If several records share a number, all are shown without guessing an association.
CRM failures are displayed separately and do not prevent answering.

The isolated browser regression starts and stops its own test server, mocks CRM
and SIP, and never places real calls:
`node --test frontend/tests/inbound.browser.test.mjs` (from the repository root).
It uses Playwright's installed Chromium, or an installed Chrome when run with
`PLAYWRIGHT_CHANNEL=chrome`.
