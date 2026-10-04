-- Hosts, tenants and the runtimes placed on them.
--
-- One AI17Z. These rows describe where a copy of it is running when that is
-- not the owner's own machine, and nothing here is required for local mode.
--
-- Two shapes in this schema are security decisions rather than conveniences.
--
-- A host proves an asymmetric key it holds; there is no column for a shared
-- secret, because one leaked copy of a secret deployed to every node is every
-- node. Enrolment is an administrator approving a public key that a host
-- offered, and revocation is a state the host cannot leave by itself.
--
-- A tenant's runtime is addressed by its own id, and a host is told that id
-- and a resource policy. There is no owner email, payment wallet, real name or
-- X handle in anything a host daemon needs to read, because a host does not
-- need to know whose agent it is holding in order to hold it.

-- Somebody who supplies hardware. First-party for now; the other tiers exist
-- so the architecture is built for them and are refused by the scheduler.
CREATE TABLE host_providers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label       text NOT NULL,
  tier        text NOT NULL CHECK (tier IN ('FIRST_PARTY_TRUSTED', 'VERIFIED_PROVIDER', 'CONFIDENTIAL_COMPUTE')),
  -- Free text for the operator, never shown to a tenant.
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  retired_at  timestamptz
);

-- A machine. Connects outward; nothing here is an address to dial it on.
CREATE TABLE host_nodes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id       uuid NOT NULL REFERENCES host_providers (id) ON DELETE RESTRICT,
  label             text NOT NULL,
  -- The public half of the key the host signs with. The private half never
  -- leaves the host, and this column is the whole of what we keep.
  public_key_jwk    jsonb NOT NULL,
  -- Stable fingerprint of that key, so a host can be named in a log without
  -- printing the key and without being renamed out from under one.
  key_thumbprint    text NOT NULL UNIQUE,
  state             text NOT NULL DEFAULT 'PENDING_ENROLMENT'
                      CHECK (state IN ('PENDING_ENROLMENT', 'ACTIVE', 'DRAINING', 'UNREACHABLE', 'REVOKED')),
  -- What the host measured about itself. Never a figure anybody typed.
  capacity          jsonb,
  -- Opaque to tenants; used for stable placement.
  region            text,
  agent_version     text,
  -- Evidence, as opposed to the state column, which is a memory.
  last_heartbeat_at timestamptz,
  enrolled_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  enrolled_at       timestamptz,
  revoked_at        timestamptz,
  revoked_reason    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX host_nodes_schedulable_idx ON host_nodes (state) WHERE state = 'ACTIVE';

-- A customer. One tenant, one or more agents, never shared with anybody else.
CREATE TABLE hosted_tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Studio's account reference. Opaque here: identity belongs to Studio.
  account_ref   text NOT NULL UNIQUE,
  label         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Retained rather than deleted, because deleting a tenant row would orphan
  -- the record of what was once running for them.
  retired_at    timestamptz
);

-- One isolated AI17Z for one tenant.
--
-- Cross-customer sharing is prohibited, and the unique index below is what
-- makes that a property of the database rather than a rule somebody remembers:
-- a runtime belongs to exactly one tenant, and a tenant's runtimes are its own.
CREATE TABLE hosted_runtimes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES hosted_tenants (id) ON DELETE RESTRICT,
  -- Null while unplaced, and after a host is lost. Deliberately not
  -- reassigned on its own: starting the same agent twice is worse than
  -- leaving it down.
  host_id           uuid REFERENCES host_nodes (id) ON DELETE SET NULL,
  runtime_class     text NOT NULL,
  state             text NOT NULL DEFAULT 'PROVISIONING'
                      CHECK (state IN ('PROVISIONING', 'MIGRATING', 'READY', 'ACTIVE', 'GRACE', 'SUSPENDED',
                                       'RETAINED', 'DELETION_SCHEDULED', 'DELETED', 'HOST_UNREACHABLE', 'FAILED')),
  version           text NOT NULL,
  region            text,
  -- Bumped when a runtime is replaced on new hardware, so a stale host
  -- reporting about an old generation cannot be mistaken for the live one.
  generation        integer NOT NULL DEFAULT 1,
  -- How the master key is held for this runtime. The key itself is never here:
  -- every runtime has its own, and Studio holds no plaintext copy.
  key_custody       text NOT NULL DEFAULT 'HOST_SEALED'
                      CHECK (key_custody IN ('HOST_SEALED', 'ATTESTED_RELEASE')),
  -- What the entitlement says, mirrored for scheduling. Studio is the source.
  entitlement_ref   text,
  entitled_until    timestamptz,
  -- One provisioning per request, whatever a retry does.
  provision_key     text NOT NULL UNIQUE,
  last_health_at    timestamptz,
  health            jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hosted_runtimes_tenant_idx ON hosted_runtimes (tenant_id, created_at DESC);
CREATE INDEX hosted_runtimes_host_idx ON hosted_runtimes (host_id) WHERE host_id IS NOT NULL;
-- What a host is allowed to be holding, for the scheduler's reserved sums.
CREATE INDEX hosted_runtimes_live_idx ON hosted_runtimes (host_id, state)
  WHERE state IN ('PROVISIONING', 'MIGRATING', 'READY', 'ACTIVE', 'GRACE');

-- A short-lived permission for one owner to reach one runtime.
--
-- Studio authenticates the human; this is the grant that follows. It is bound
-- to a tenant, a runtime, a scope and an expiry, and it is stored as a hash so
-- a leaked database does not become a set of working session tokens. The
-- browser never names its own runtime: this row is what says which one.
CREATE TABLE runtime_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  runtime_id    uuid NOT NULL REFERENCES hosted_runtimes (id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES hosted_tenants (id) ON DELETE CASCADE,
  -- Who it was issued for, by Studio's reference rather than by email.
  account_ref   text NOT NULL,
  -- sha256 of the token. The token itself is returned once and never stored.
  token_hash    text NOT NULL UNIQUE,
  scopes        jsonb NOT NULL,
  -- Single use for anything sensitive; reusable for ordinary dashboard calls.
  single_use    boolean NOT NULL DEFAULT false,
  used_at       timestamptz,
  expires_at    timestamptz NOT NULL,
  -- Revoked rather than deleted, so a session list can show what was ended.
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runtime_grants_runtime_idx ON runtime_grants (runtime_id, created_at DESC);
CREATE INDEX runtime_grants_live_idx ON runtime_grants (expires_at) WHERE revoked_at IS NULL;

-- An encrypted copy of a tenant, kept off the machine that made it.
--
-- Possession of a backup must not be authority to read it. The encryption is
-- the runtime's own, so a host or a bucket holding these holds ciphertext, and
-- `verified_at` records that somebody actually checked it could be read back
-- rather than trusting that writing it succeeded.
CREATE TABLE runtime_backups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  runtime_id    uuid NOT NULL REFERENCES hosted_runtimes (id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES hosted_tenants (id) ON DELETE CASCADE,
  generation    integer NOT NULL,
  -- Where the ciphertext is. Never credentials for getting it.
  location      text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes >= 0),
  -- Of the ciphertext, so a corrupt copy is caught before it is relied on.
  sha256        text NOT NULL,
  verified_at   timestamptz,
  verify_error  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runtime_backups_runtime_idx ON runtime_backups (runtime_id, created_at DESC);
