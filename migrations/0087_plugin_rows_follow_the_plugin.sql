-- Configuration, secrets and budget rows belong to an installed Plugin, and
-- the database should be the thing that says so.
--
-- 0086 left `plugin_id` as bare text on all three, and `removeInstalledPlugin`
-- deleted them by hand inside a transaction. That works and is exactly the
-- arrangement this repository keeps deciding it does not want: a guarantee
-- that lives in application code is one a second caller can forget. A sealed
-- credential surviving the Plugin it belonged to is the worst version of it,
-- because reinstalling later would silently hand a Plugin a secret its owner
-- last thought about months ago.
--
-- The rows are cleaned up first, since an installation could already hold an
-- orphan written before this ran. There is exactly one: the dev database this
-- was built against. On a fresh installation these delete nothing.
DELETE FROM agent_plugin_secrets
 WHERE plugin_id NOT IN (SELECT id FROM installed_plugins);
DELETE FROM agent_plugin_config
 WHERE plugin_id NOT IN (SELECT id FROM installed_plugins);
DELETE FROM plugin_call_budget
 WHERE plugin_id NOT IN (SELECT id FROM installed_plugins);

ALTER TABLE agent_plugin_config
  ADD CONSTRAINT agent_plugin_config_plugin_fk
  FOREIGN KEY (plugin_id) REFERENCES installed_plugins (id) ON DELETE CASCADE;

ALTER TABLE agent_plugin_secrets
  ADD CONSTRAINT agent_plugin_secrets_plugin_fk
  FOREIGN KEY (plugin_id) REFERENCES installed_plugins (id) ON DELETE CASCADE;

ALTER TABLE plugin_call_budget
  ADD CONSTRAINT plugin_call_budget_plugin_fk
  FOREIGN KEY (plugin_id) REFERENCES installed_plugins (id) ON DELETE CASCADE;
