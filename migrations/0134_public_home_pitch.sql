-- The owner's one-line pitch for a public-home share post. Owner-approved, and
-- never part of the published manifest. Null until the owner writes one.
ALTER TABLE agent_public_home ADD COLUMN pitch text;
