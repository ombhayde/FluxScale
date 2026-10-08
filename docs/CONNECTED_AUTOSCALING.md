# Connected autoscaling: implemented scope and remaining gates

The intended product is a user-specific FluxScale dashboard that connects to a
user's deployed application and automatically adds and removes real application
replicas. Monitoring, forecasts and displayed decisions alone do not satisfy this
target. The account/project hub, outbound agent and versioned local policy delivery are
implemented and verified locally. Remote production deployment remains a separate
validation gate.

## Existing foundation

The current release runs one controller beside one trusted Docker application on
one host. Its SDK reports live request telemetry, its executor starts and stops
actual containers, and its proxy routes requests to healthy replicas and drains
requests before scale-in. Restart adoption and persisted control state are covered
by existing verification. See [the current integration guide](INTEGRATION.md) and
[verification evidence](VERIFICATION.md).

The connected extension provides individual accounts, server-enforced project
ownership and single-use host enrollment. Users open the original React console
with project-scoped live reports using their account session. Local controller role
tokens stay on the deployment host. See [deployment setup](CONNECTED_DEPLOYMENT.md)
and [the recorded two-user demo](DEMO.md).

## First supported deployment

Start with a stateless Dockerized HTTP application on a Linux VM, whether the VM
is on AWS, GCP, another provider or a private server. The first integration reuses
the Node/Express SDK. This scales application containers within the VM's available
resources; adding or removing cloud VMs requires a separate provider integration.
Kubernetes, managed serverless platforms and non-container applications require
their own execution and routing integrations.

The central dashboard can be self-hosted. A small enrolled host component runs
the existing controller and proxy locally. Customer requests stay on the user's
infrastructure; central administration and telemetry use authenticated outbound
HTTPS. The local controller remains responsible for health, replica ownership,
resource limits, request draining and continuity during a dashboard outage.

## User integration flow

1. Sign in, create a project and generate a short-lived, single-use host enrollment
   token.
2. Run the provided installer on the deployment host. Exchange enrollment for a
   revocable credential scoped to that host and project.
3. Select an application image, port, health endpoint, required environment,
   resource quotas and minimum/maximum replicas. Validate telemetry and replica
   health before enabling automatic actions.
4. Install the SDK and configure the existing HTTPS ingress to send customer
   requests through the local FluxScale proxy. Provide a maintenance-window
   migration for an existing application; do not silently take ownership of
   unrelated containers.
5. Enable autoscaling. Observe real replica changes, requests distributed to new
   healthy replicas and safe scale-in. Offer pause and bounded manual overrides
   with an audit trail.

A project URL alone cannot provide Docker control or application instrumentation.
Onboarding needs one-time host authorization, application telemetry and traffic
routing setup. The installer should automate the repeatable steps and explain the
remaining application-specific requirements.

## Implemented controls and deployment requirements

- Accounts and persistent project/host records, with server-enforced ownership on
  every read and action. Derive tenant scope from verified identity; never trust a
  client-supplied tenant identifier. Separate metrics, decisions, credentials,
  audit records and service names across customers.
- Enrollment, credential revocation and authenticated host reporting. Never expose
  the Docker daemon to the public Internet for onboarding. Docker access stays
  local to the enrolled host.
- A connected dashboard with host status, setup progress, live traffic, actual
  replicas, scaling history, policy controls and actionable setup errors.
- Durable, host-scoped policy delivery with versions, acknowledgements and
  idempotency. Reject expired or unauthorized instructions. Expose bounded scaling
  controls rather than arbitrary remote shell execution.
- Deployment gates: protect administration with HTTPS, bound host resource use,
  define local behavior during disconnects, preserve state across upgrades, and
  verify recovery and rollback on the supported remote deployment.

Tenant authorization follows the principles in
[OWASP's multi-tenant security guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html).
Local Docker access avoids opening its privileged daemon to the network; see
[Docker's daemon access guidance](https://docs.docker.com/engine/security/protect-access/).

## Completion evidence

Remote production readiness still requires a fresh user to onboard a real
remote application from the shipped instructions and the following checks pass:

- Two users cannot read or control each other's projects, hosts or telemetry,
  including when service names are identical.
- Real customer-path requests trigger scale-out, reach multiple healthy application
  containers, and later trigger scale-in without losing in-flight requests.
- Invalid telemetry, revoked credentials, duplicate instructions, exhausted host
  capacity and failed health checks produce bounded, visible failure behavior.
- The host continues according to its documented local policy when the central
  dashboard disconnects, and reconnects without duplicate replicas or actions.
- Controller/host restart, enrollment revocation, upgrade and rollback are verified
  on the target VM with deployment-specific application traffic and a sustained
  workload. A local demo run alone is not this evidence.
