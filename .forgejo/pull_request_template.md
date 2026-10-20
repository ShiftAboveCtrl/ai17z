## What this changes

<!-- What behaviour is different afterwards, in a sentence or two. -->

## Why

<!-- What was wrong, or what could not be done before. If it fixes an issue,
     link it. -->

## How it was verified

<!-- Which gates you ran. Please say what you actually ran rather than what
     usually passes: a claim of green that was not executed costs more time
     than an honest gap. -->

- [ ] `npm test` (or the focused suites that cover this)
- [ ] `npm run typecheck` with `*.tsbuildinfo` removed first
- [ ] `npm run lint`
- [ ] `npm run release:check`
- [ ] Database changes: a new numbered migration, applied to a fresh database and an existing one

## Regression coverage

<!-- A behaviour change needs a test that would fail without it. Which test,
     and have you confirmed it fails when the change is reverted? -->

## Anything a reviewer should know

<!-- Trade-offs, things deliberately left out, or a limitation worth recording. -->

---

- [ ] No secrets, keys, cookies, profiles or personal data are included in this change
- [ ] Comments explain *why* rather than restating *what*
