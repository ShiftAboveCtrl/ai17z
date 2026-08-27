import { useState, type FormEvent } from 'react';
import { ApiError } from '@app/lib/api';
import { useSession } from '@app/lib/session';
import { Field, Spinner } from '@app/components/ui';
import { AnimatedText, FadeIn } from '@app/components/motion';

/**
 * First run and sign-in share one screen. There is nothing to configure before
 * an owner exists, so the platform asks for exactly one thing.
 */
export function Welcome() {
  const { needsOwner, signIn, createOwner } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (needsOwner) await createOwner({ email, password, displayName: displayName || 'Owner' });
      else await signIn(email, password);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-page flex-col justify-center px-6 py-20 sm:px-10">
      <div className="grid gap-16 lg:grid-cols-[1.15fr_1fr] lg:items-center lg:gap-24">
        <div>
          <FadeIn>
            <p className="eyebrow mb-8">{needsOwner ? 'First run' : 'Welcome back'}</p>
          </FadeIn>
          <AnimatedText
            as="h1"
            text="Build agents, not bots."
            className="monument text-[13vw] leading-[0.85] sm:text-[8.5vw] lg:text-[6.4vw]"
          />
          <FadeIn delay={0.35}>
            <p className="mt-10 max-w-md text-lg font-light leading-relaxed text-bone-dim">
              AI17Z runs autonomous agents on your own machine. Give one an identity, a memory, and a model, then watch
              every decision it makes.
            </p>
          </FadeIn>
        </div>

        <FadeIn delay={0.2}>
          <form onSubmit={onSubmit} className="panel w-full max-w-md space-y-5 p-7">
            <h2 className="text-xl font-light text-bone">
              {needsOwner ? 'Create your owner account' : 'Sign in'}
            </h2>

            {needsOwner && (
              <Field label="Your name" htmlFor="displayName">
                <input
                  id="displayName"
                  className="field"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  autoComplete="name"
                  placeholder="Alex"
                />
              </Field>
            )}

            <Field label="Email" htmlFor="email">
              <input
                id="email"
                type="email"
                required
                className="field"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                placeholder="you@example.com"
              />
            </Field>

            <Field
              label="Password"
              htmlFor="password"
              hint={needsOwner ? 'At least 8 characters. Stored as a scrypt hash, never in plain text.' : undefined}
            >
              <input
                id="password"
                type="password"
                required
                minLength={needsOwner ? 8 : 1}
                className="field"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={needsOwner ? 'new-password' : 'current-password'}
              />
            </Field>

            {error && (
              <p className="rounded-lg border border-signal-fail/30 bg-signal-fail/[0.06] px-3 py-2.5 text-sm text-signal-fail">
                {error}
              </p>
            )}

            <button type="submit" className="btn-primary w-full" disabled={busy}>
              {busy && <Spinner />}
              {needsOwner ? 'Create account' : 'Sign in'}
            </button>
          </form>
        </FadeIn>
      </div>
    </main>
  );
}
