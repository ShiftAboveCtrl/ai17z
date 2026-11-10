This private workspace adapts the faker 7 APIs used by `@farcaster/core` 0.21's
bundled factories to the real `@faker-js/faker` 10.6.0. Those factories run during
module initialization even when the application only uses message builders.

The root override redirects only Farcaster's `^7.6.0` dependency here. All faker
implementation code comes from the patched upstream dependency; this package
adds only `datatype.number`, `datatype.datetime`, `random.alphaNumeric`, and
positional `date.between` compatibility. It does not mutate upstream faker.

The lockfile records the override link relative to the workspace root, matching
npm's override validation. Keep that link pointing to `packages/faker-compat`
when updating dependencies: npm can incorrectly resolve a newly added relative
file override against the dependent package's directory instead.
