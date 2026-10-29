# dialer Setup Guide

## Linked contact notes

The contact timeline, contact Notes panel, and dialer Notes/contact panels show
native Twenty Notes linked through Note Targets, alongside the existing contact
notes field. Each linked note retains its title, content, author and creation
time. Linked notes are read-only in the dialer; edit them in Twenty.
`GET /api/notes?contactType=prospect&contactId=<uuid>` (or `contactType=lead`)
uses the same signed-in dialer authentication as other contact endpoints.
Use **Refresh** in the linked-notes panel to load externally added notes immediately.

## Quick start

```bash
./scripts/setup.sh            # install, create .env.local files, check the Twenty schema
./scripts/setup.sh --apply    # ...and create whatever the schema is missing
./scripts/setup.sh --seed     # ...and load the demo workspace (fresh workspaces only)
bun run dev                   # backend on :4000, frontend on :5173
```

Or the same steps by hand: `bun run install:all`, copy `.env.example` to
`.env.local` and `frontend/.env.example` to `frontend/.env.local`, then
`bun run twenty:schema` and optionally `bun run twenty:seed`.

## Authentication

Twenty is the identity provider. Sign in with your Twenty account through
OAuth with PKCE ([docs/identity.md](docs/identity.md)); the dialer keeps no
users or passwords of its own, and signup is disabled.

## Telnyx AI discovery calls

The contact sidebar has **Call with AI**, separate from the human softphone.
It calls one UK contact at a time, identifies itself as an AI assistant,
discovers requirements and offers a free, no-obligation meeting with Matthew.
It cannot agree prices, discounts, contracts or delivery dates. Campaign scripts
provide reference material, not permission to override these limits.

Live calling is **off by default**. Only server-allowlisted internal numbers or
leads with explicit permission for an automated AI sales call are allowed.
The operator must enter evidence of that permission for every call; it is
saved with their member ID and timestamp. Public business numbers are not
consent. Confirm applicable automated marketing, privacy and retention rules
before enabling prospect calls. The feature does not start audio recording;
conversation transcripts are stored in Twenty and processed by Telnyx.

### Provision from the terminal

Use the existing repo-root `.env.local` for server secrets, never `VITE_`
variables. Supply `TWENTY_BASE_URL`, `TWENTY_API_KEY`, `TELNYX_API_KEY`,
`TELNYX_WEBHOOK_TOKEN`, `TELNYX_CALL_CONTROL_APP_ID` and an explicitly chosen
`AGENCY_PHONE_NUMBER` matching an ACTIVE Twenty phone record. Keep the existing
human dialer's configuration intact.

Add these variables:

```dotenv
AI_VOICE_ENABLED=false
AI_VOICE_PUBLIC_URL=https://your-dialer.example.com
AI_VOICE_SECRET=<a dedicated random secret of at least 32 characters>
AI_VOICE_TEST_NUMBERS=<your own UK test number in E.164>
TELNYX_AI_ASSISTANT_ID=
# Optional; unset model uses Telnyx's default.
TELNYX_AI_MODEL=
TELNYX_AI_VOICE=Telnyx.KokoroTTS.af_heart
```

Generate the dedicated secret with `openssl rand -hex 32`. Retain it securely:
changing it invalidates per-call tool credentials and prevents recovery of
previously encrypted booking state.

```bash
# Inspect the assistant configuration; no provider changes or calls.
bun run ai:voice:setup --dry-run

# After the base dialer schema exists, add voice fields and durable locks.
bun run ai:voice:setup --schema --apply

# Alternative: use the existing Twenty secrets inside the deployed backend.
# Requires matching AI_VOICE_SECRET locally and on Vercel, and calling disabled.
bun run ai:voice:setup --schema --remote --apply

# Create/update the named assistant and read it back to verify.
bun run ai:voice:setup --apply

# Offline checks: fictional contacts and mocked provider/calendar HTTP.
bun run test:ai-voice
```

The setup command outputs `TELNYX_AI_ASSISTANT_ID`; save that value locally
and in backend deployment configuration. It never purchases or reassigns phone
numbers, repoints an existing webhook, or places a call. It uses Telnyx's
supported inline webhook tools for compatibility with the installed SDK.

Deploy the backend and frontend changes before setting `AI_VOICE_ENABLED=true`.
`AI_VOICE_PUBLIC_URL` must be the public HTTPS origin routing `/api/*` to this
Express backend. The Call Control application's webhook must be:

```text
https://your-dialer.example.com/api/webhooks/telnyx?token=<TELNYX_WEBHOOK_TOKEN>
```

The legacy standalone `frontend/api/telnyx-webhook.ts` receiver does not implement
AI orchestration. Use the root multi-service Vercel configuration (or the
Express server), not a frontend-only deployment. Setup validates the configured
application URL without changing it.
Remote schema bootstrap is HMAC-authenticated with the dedicated voice secret,
can only add the voice fields/locks, and refuses requests while AI calling is
enabled. It never returns deployment credentials. Use this when Vercel's
non-exportable secrets are the only copy of the Twenty credentials.

### Booking tools

The assistant uses server-authenticated, per-call webhook tools:
`meeting_details`, `availability`, `book`, `callback`, `opt_out` and `end`.
No CRM API key or booking management credential is exposed to tool arguments.
The backend uses [Fewzen's booking contract](https://booking.fewzen.ai/openapi.json)
and [booking guide](https://booking.fewzen.ai/AGENTS.md); publishing `llms.txt`
alone does not install these tools.

Availability is live, not a reservation. The prospect must confirm their name,
email, IANA timezone and selected returned slot. A random 32-byte booking
idempotency key and the original payload are encrypted and persisted before
booking. Timeouts and unknown outcomes reuse the same key and payload; only an
explicit unavailable-slot response permits a newly agreed slot and new key.
The private management URL is encrypted at rest and omitted from model tool
responses, transcripts and ordinary CRM notes. Booking confirmation updates the
call's existing meeting fields explicitly; Fewzen's own CRM sync is best-effort.
This first version does not expose rescheduling to the voice agent.

The booking service documents 10 creation requests per client per 15 minutes.
Rate-limit errors are reported and must not be interpreted as bookings.

### Call lifecycle and recovery

Calls persist before dialing and continue without an open browser. Maximum
ring time is 30 seconds; maximum call time is 600 seconds. Database-unique
reservations in `agencyVoiceLocks` coordinate AI calls with human number
claim/state/heartbeat/release operations while AI calling is enabled. Startup
checks the required unique constraints instead of relying on process memory.

Provider answer events start the assistant; hangup events finalize the call and
release reservations. Conversation events attach only user/assistant text,
excluding system instructions and tool credentials. A final conversation event
also generates the existing AI summary/rating when `OPENAI_API_KEY` is configured.
Duplicate and late call events cannot reopen an ended call.

**End AI call** sends a server-side hangup request; provider confirmation releases
the number. An uncertain dial or lost terminal webhook deliberately keeps its
reservation: do not automatically expire it or launch another call. Inspect the
call in Telnyx, stop any active leg, then replay its authenticated hangup webhook
to the canonical backend. If the provider never created a call, an operator must
verify that fact before manually clearing the matching reservation's `lockKey`
and deleting it in Twenty. Do not clear reservations while a call or booking
operation might still be running. Orphaned operation locks after a server crash
likewise require verification before release.

Test internal calls for interruptions, voicemail, opt-out, no answer, callback,
calendar conflict, lost booking confirmation, duplicate triggers, hangup and
closing the browser before enabling consented prospect calls. Offline tests do
not certify the deployed phone number, provider account, audio or callback reachability.

## Data

There is no database. Every record is a custom object in your Twenty
workspace, created by `bun run twenty:schema` from
[backend/src/lib/twenty/schema/manifest.ts](backend/src/lib/twenty/schema/manifest.ts):
`agencyProspect`, `agencyLead`, `agencyCampaign`, `agencyScript`,
`agencyPhone`, `agencyCall`, `agencyPerson`, `agencyOffer`, `agencyVoiceLock`, `callCampaign`
and `dialerAudioSession`. The command only adds what is missing;
`bun run twenty:schema:check` is the dry run.

Select options use Twenty-compatible colors, including gray for Do Not Contact
and green for Converted and inbound UTM attribution. These colors do not change
the stored option values or calling behavior.

`bun run twenty:seed` loads the demo workspace the screenshots show (24
fictional businesses, 48 calls, scripts, numbers, dial lists). It refuses to
write to a workspace that already has real prospects unless you pass
`-- --force`, and `bun run twenty:seed -- --reset` removes it.

## Environment Variables

### Backend (.env.local at the repo root)

```bash
TWENTY_BASE_URL=https://twenty.example.com
TWENTY_API_KEY=<your-key>
SYNC_POLL_INTERVAL_MS=30000
PORT=4000
JWT_SECRET=<secret>

# Identity — Twenty OAuth (see docs/identity.md; the client is public PKCE-only)
TWENTY_OAUTH_CLIENT_ID=<registered-client-id>
TWENTY_OAUTH_CLIENT_SECRET=
TWENTY_OAUTH_REDIRECT_URI=http://localhost:5173/callback
TWENTY_OAUTH_SCOPE=api profile

# Only needed because this instance is behind an auth-guard nginx with basic auth:
TWENTY_BASIC_USER=
TWENTY_BASIC_PASSWORD=

# Voice + AI analysis (see docs/ai-analysis.md)
TELNYX_API_KEY=<your-key>
TELNYX_MESSAGING_PROFILE_ID=
# Shared secret for the Telnyx webhook (?token=).
#
# Set this on the Telnyx Call Control application's "Webhook Event URL" to the
# CANONICAL receiver for the environment the dialer is served from:
#
#   production (Vercel, root dir = frontend)  /api/telnyx-webhook?token=<value>
#   local dev (Express on :4000)              /api/webhooks/telnyx?token=<value>
#
# The Vercel app is a Vite SPA with one serverless function
# (frontend/api/telnyx-webhook.ts). Any other /api/* path there returns the SPA
# index.html, so a webhook pointed at the Express path silently receives HTML
# and Telnyx gives up after its retries -- call rows keep their recording id and
# transcriptionStatus=PENDING forever, with no transcript. Verify after any
# change (a correct token answers 200 {"ok":true,...}; HTML or 405 means the
# URL is wrong):
#
#   curl -X POST "https://<vercel-app>/api/telnyx-webhook?token=<value>" \
#     -H 'content-type: application/json' -d '{"data":{"event_type":"ping"}}'
TELNYX_WEBHOOK_TOKEN=
# Single canonical agency number (E.164). Empty = first ACTIVE row.
AGENCY_PHONE_NUMBER=
# Stale claim reap (minutes); default 60.
CLAIM_STALE_AFTER_MINUTES=60
# Single OpenAI-compatible key for call ratings (any base URL works).
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_ANALYSIS_MODEL=gpt-4o-mini
```

### Frontend (frontend/.env.local)

```bash
VITE_API_URL=                      # empty = same origin, proxied to :4000 in dev
VITE_SIP_PROVIDER=telnyx
VITE_SIP_URI=sip:your-username@sip.telnyx.com
VITE_SIP_PASSWORD=
VITE_SIP_WS_URL=wss://sip.telnyx.com:7443
VITE_SIP_CALLER_ID=+15551234567
```

## Where each environment actually runs

The Vercel project has **Root Directory = `frontend`**. That single fact decides
what is live:

| Piece                            | Production                                                    | Local dev                                    |
| -------------------------------- | ------------------------------------------------------------- | -------------------------------------------- |
| SPA (`frontend/`)              | Vercel static build                                           | `vite` on :5173, `/api` proxied to :4000 |
| Telnyx webhook                   | `frontend/api/telnyx-webhook.ts` → `/api/telnyx-webhook` | Express → `/api/webhooks/telnyx` on :4000 |
| Everything else under `/api/*` | **not deployed**                                        | Express on :4000                             |

Consequences worth knowing before you point anything at the deployed app:

- The root `vercel.json` (`services` + `/api/* -> backend service`) is **outside
  the project root directory and therefore ignored**. Do not expect
  `/api/health`, `/api/calls/*`, or `/api/prospects/*` on the deployed host --
  they answer with the SPA `index.html`. If you need the Express API in
  production, set the Vercel Root Directory to the repo root (which activates
  `services`) and redeploy.
- Recording playback in the SPA uses `/api/calls/:id/audio` whenever a call row
  has a `telnyxRecordingId`, which that route only exists for in the Express
  backend. On the Vercel deployment those rows need a durable `recordingUrl`
  (e.g. object storage) to be playable; Telnyx's own `recording_urls` are signed
  links that expire in minutes and must not be relied on as stored values.
