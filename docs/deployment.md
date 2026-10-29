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
only when no agent is registered:

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

The browser reports a short-lived heartbeat while its SIP registration is
active. If one is live, Telnyx calls the SIP address; otherwise it dials the
fallback mobile. The outbound leg uses the inbound business number as caller
ID and bridges to the caller when the destination answers. While it rings, the
66-second MP3 plays on repeat for the caller and stops when the destination
answers. This applies only to inbound calls to `TELNYX_INBOUND_NUMBER`; it does
not fall back just because a registered agent misses the call.

Browser SIP legs carry the original caller number in the
`X-Dialer-Original-Caller` header so the incoming-call UI and call log identify
the caller, not the business number used for the bridge. Mobile fallback legs
continue to present the business number as caller ID.
