-- Thread admission is a fact about the update, not a field of resolved context.
-- A recovery that rewrites the job context must not admit the thread again.
ALTER TABLE dev_updates ADD COLUMN thread_admitted_at timestamptz;
