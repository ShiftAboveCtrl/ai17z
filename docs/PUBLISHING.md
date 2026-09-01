# Publishing AI17Z

Everything that could be done in code has been. What is left needs an account,
a decision, or a machine nobody here has.

The repository is otherwise ready: a clean clone installs, starts and passes its
own doctor with nothing but Docker, Node and Chrome on the machine. That was
verified by doing it, twice, from an empty directory.

---

## Before you push

### 1. Point it at your repository

Four URLs are derived from one: the clone URL, the zip, and the raw URL of each
bootstrap script. Create the repository on GitHub first, then:

```powershell
.\scripts\set-repo-url.ps1 -Url https://github.com/YOU/ai17z
```

It takes any form GitHub shows you, including the SSH one, and rewrites every
tracked `.md`, `.ps1` and `.sh` that mentions a placeholder. Check it with
`git diff`.

Pass `-Branch` if your default branch is not `main`; the zip and raw URLs both
name a branch and would otherwise 404.

### 2. Check nothing personal is going out

CI runs these on every pull request, but run them once before the first push,
when there is no CI yet:

```bash
git grep -nEi "sk-[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN"
git grep -nEi "your-handle|your-name|@yourdomain"
git ls-files | grep -E "^\.env$|^storage/|accounts\.db"
```

All three should print nothing. `.env`, `storage/` and the browser profiles are
gitignored and have never been tracked.

### 3. Decide what the repository says it is

The description and topics are not in the repository, so they are yours to set:

- **Description**: "Local-first platform for running autonomous agents on X.
  Real Chrome, durable pipeline, everything it decides is on one page."
- **Topics**: `autonomous-agents`, `ai-agents`, `typescript`, `playwright`,
  `postgresql`, `local-first`, `x-twitter`

### 4. Screenshots, if you want them

The README has none. If you add any, use a demo agent on the mock channel
rather than your own timeline: a screenshot of a real account is a screenshot of
real people who did not agree to be in it.

---

## After you push

### Turn CI on

`.github/workflows/ci.yml` runs typecheck, the whole test suite against a real
Postgres, the web build, and a secret scan. It needs nothing configured: no
secrets, no tokens, no paid runners. It will run on the first pull request.

### Tag a release

```bash
git tag -a v0.1.0 -m "First public release"
git push origin v0.1.0
```

`ai17z-oss-rc` is a working tag from development. It is not a release name.

---

## What to tell people is not finished

The README says this already, in **Support**. Repeating it here so it is not
lost when you write an announcement:

- **Ubuntu is not verified.** The scripts are written, syntax-checked and their
  branches exercised, but nobody has taken a clean Ubuntu machine through the
  flow. Say "should work, untested" rather than "supported", and the first
  person who tries it will tell you which of those it was.
- **Headless servers are not a supported flow.** Connecting an X account opens a
  real Chrome window for a person to sign in to.
- **One X account has been run end to end.** Two agents in one installation and
  two installations on one machine are both tested; two signed-in X accounts
  side by side are not.
- **Vision depends on the provider.** It works, and the image is fetched and
  inlined rather than handed over as a URL, because X's CDN refuses providers.
  Whether any given model reads it is that model's business.

---

## The one thing a new user gets wrong

They start it, create an agent, and it does nothing, because no model provider
is configured. The doctor now says so in as many words:

```
AI providers    NOT CONFIGURED  None yet. An agent cannot think without one.
```

It used to say `PASS  1 configured` on an installation with none, because it
counted any optional health component and the browser is one. If somebody
reports an agent that will not answer, that is the first thing to check.
