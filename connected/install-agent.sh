#!/bin/sh
set -eu
: "${FLUXSCALE_HUB_ORIGIN:?Set your HTTPS hub origin}"
: "${FLUXSCALE_SERVICE:?Set the project's service ID}"
: "${FLUXSCALE_READ_TOKEN:?Load the local controller read credential}"
: "${FLUXSCALE_MANAGED_TOKEN:?Load the local controller managed credential}"
: "${FLUXSCALE_ENROLLMENT_TOKEN:?Generate an enrollment code in your dashboard}"
case "$FLUXSCALE_SERVICE" in *[!a-zA-Z0-9_.-]*|'') echo 'Invalid service ID' >&2; exit 1;; esac
if [ "$(uname -s)" != Linux ]; then echo 'This installer supports Linux Docker hosts.' >&2; exit 1; fi
agent_source=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
agent_data=${FLUXSCALE_AGENT_DATA:-"$HOME/.fluxscale/agent"}
if docker container inspect fluxscale-agent >/dev/null 2>&1; then echo 'An agent already exists. Use the documented upgrade procedure.' >&2; exit 1; fi
mkdir -p "$agent_data"
chmod 700 "$agent_data"
docker run --rm --network none -v "$agent_data:/data" --env FLUXSCALE_HUB_ORIGIN --env FLUXSCALE_SERVICE node:24-alpine node -e '
const fs=require("fs"); const path="/data/agent.json";
if(fs.existsSync(path)) throw Error("Agent identity already exists; preserve it for upgrades or archive it before re-enrollment");
const hub=new URL(process.env.FLUXSCALE_HUB_ORIGIN);
if(hub.protocol!=="https:" || hub.origin!==process.env.FLUXSCALE_HUB_ORIGIN) throw Error("Use an HTTPS hub origin");
fs.writeFileSync(path,JSON.stringify({hub:hub.origin,controller:"http://127.0.0.1:8080",service:process.env.FLUXSCALE_SERVICE}),{mode:0o600});'
docker run -d --name fluxscale-agent --restart unless-stopped --network host \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --memory 256m --cpus 0.5 \
  -v "$agent_source:/app:ro" -v "$agent_data:/data" \
  --env FLUXSCALE_READ_TOKEN --env FLUXSCALE_MANAGED_TOKEN --env FLUXSCALE_ENROLLMENT_TOKEN \
  node:24-alpine node /app/agent.mjs /data/agent.json
echo 'Agent installed. Check host acknowledgement in your dashboard, then enable scaling.'
echo 'Keep this source directory in place. Unset FLUXSCALE_ENROLLMENT_TOKEN in your shell.'
