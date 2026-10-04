-- What one runtime reserves, so a host can be placed on rather than guessed at.
--
-- Placement was written and then deliberately not exposed, because choosing a
-- host needs what is already reserved on it in CPU, memory and disk, and the
-- only thing recorded was a class name. Counting runtimes and multiplying by
-- an assumed class would produce refusals and acceptances nobody could
-- explain, which is worse than having no placement at all.
--
-- So a class is a row. It is a reservation rather than a limit discovered
-- later: the scheduler subtracts these from a host before anything starts, and
-- a machine cannot be promised twice.
--
-- These numbers are not marketing figures and nothing here is evidence of how
-- many agents a machine holds. A class says what is set aside; what a machine
-- can actually carry is measured, and nothing in this repository has measured
-- one yet.

CREATE TABLE runtime_classes (
  -- Chosen by the operator and referenced by hosted_runtimes.runtime_class,
  -- which is a text column and stays one: a runtime keeps the name of the
  -- class it was created under even after that class is retired, so the
  -- reference is deliberately not a foreign key.
  id            text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  label         text NOT NULL,
  -- Fractional cores are allowed because a text-only agent does not need one.
  cpu_cores     numeric(6, 2) NOT NULL CHECK (cpu_cores >= 0.25 AND cpu_cores <= 256),
  memory_mb     integer NOT NULL CHECK (memory_mb >= 512),
  disk_gb       integer NOT NULL CHECK (disk_gb >= 1),
  -- Whether this class may drive a browser, which costs a browser slot as well
  -- as a runtime slot. Chrome's renderers are the largest thing on a hosted
  -- machine, which is why the two are counted separately.
  browser       boolean NOT NULL DEFAULT false,
  -- Several agents, one owner. A class bounds how many share the runtime.
  max_agents    integer NOT NULL CHECK (max_agents >= 1 AND max_agents <= 1000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Retired rather than deleted: a runtime created under this class still
  -- names it, and "what was this agent given" is a fair question afterwards.
  retired_at    timestamptz
);

-- The classes an operator may still create a runtime under.
CREATE INDEX runtime_classes_live_idx ON runtime_classes (id) WHERE retired_at IS NULL;

-- What a host has set aside, summed from the classes of the runtimes on it.
--
-- A view rather than a counter column, because a counter is a second answer to
-- a question the rows already answer, and the two disagree the first time a
-- transition is rolled back. Only the states in which a runtime occupies
-- capacity are counted, and those are the same five the scheduler uses.
CREATE VIEW host_reservations AS
SELECT
  r.host_id,
  count(*)::integer                                            AS runtimes,
  count(*) FILTER (WHERE c.browser)::integer                   AS browser_runtimes,
  -- A runtime whose class was never recorded reserves nothing here, and
  -- `unmeasured` is what says so. Treating it as zero would let a host look
  -- emptier than it is, so the scheduler reads this column and refuses rather
  -- than placing against an incomplete sum.
  count(*) FILTER (WHERE c.id IS NULL)::integer                AS unmeasured,
  COALESCE(sum(c.cpu_cores), 0)::numeric(10, 2)                AS cpu_cores,
  COALESCE(sum(c.memory_mb), 0)::integer                       AS memory_mb,
  COALESCE(sum(c.disk_gb), 0)::integer                         AS disk_gb
FROM hosted_runtimes r
LEFT JOIN runtime_classes c ON c.id = r.runtime_class
WHERE r.host_id IS NOT NULL
  AND r.state IN ('PROVISIONING', 'MIGRATING', 'READY', 'ACTIVE', 'GRACE')
GROUP BY r.host_id;
