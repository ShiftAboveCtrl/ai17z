import { useRef, useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { ApiError, del, postFile } from '@app/lib/api';
import { AgentGlyph } from '@app/components/AgentGlyph';
import { ErrorPanel, Spinner } from '@app/components/ui';

interface Uploaded {
  artifactId: string;
  url: string;
  width: number;
  height: number;
  bytes: number;
  mime: string;
}

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

/**
 * Changing the agent's face.
 *
 * The picture was set once at creation and could never change, which fails
 * twice over: a likeness is the thing most likely to be wrong on the first
 * attempt, and a URL is a promise that somebody else's server keeps serving an
 * image. A picture chosen here belongs to this installation.
 *
 * The sentence about X is not decoration. Somebody about to change the face of
 * an agent that posts publicly needs to know, before they click, which face
 * they are changing.
 */
export function AvatarEditor({
  agentId,
  name,
  avatarUrl,
  onChanged,
}: {
  agentId: string;
  name: string;
  avatarUrl: string | null;
  onChanged: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Shown straight after an upload, because "did that work" should not need a
  // reload to answer.
  const [preview, setPreview] = useState<Uploaded | null>(null);

  const choose = () => {
    setError(null);
    input.current?.click();
  };

  const upload = async (file: File) => {
    setBusy('upload');
    setError(null);
    try {
      const result = await postFile<Uploaded>(`/api/agents/${agentId}/avatar`, file);
      setPreview(result);
      onChanged();
    } catch (e) {
      // The API says what is wrong with this particular file -- its size, its
      // dimensions, what it turned out to be. Passing that through beats any
      // sentence written here in advance.
      setError(e instanceof ApiError ? e.message : 'That picture could not be saved.');
    } finally {
      setBusy(null);
      // Cleared so choosing the same file again still fires a change event.
      if (input.current) input.current.value = '';
    }
  };

  const remove = async () => {
    setBusy('remove');
    setError(null);
    try {
      await del(`/api/agents/${agentId}/avatar`);
      setPreview(null);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That picture could not be removed.');
    } finally {
      setBusy(null);
    }
  };

  const current = preview?.url ?? avatarUrl;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-5">
        <AgentGlyph agentId={agentId} name={name} imageUrl={current} size="lg" interactive={false} />

        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-quiet" onClick={choose} disabled={busy !== null}>
              {busy === 'upload' ? <Spinner className="h-3.5 w-3.5" /> : <ImagePlus className="h-3.5 w-3.5" aria-hidden />}
              {busy === 'upload' ? 'Saving' : current ? 'Replace picture' : 'Choose a picture'}
            </button>
            {current && (
              <button
                type="button"
                className="btn-quiet hover:text-signal-fail"
                onClick={() => void remove()}
                disabled={busy !== null}
              >
                {busy === 'remove' ? <Spinner className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" aria-hidden />}
                Remove
              </button>
            )}
          </div>

          <p className="max-w-prose text-xs leading-relaxed text-bone-faint">
            PNG, JPEG, GIF or WebP, at least 64 pixels on its shortest side and under 5MB. Without one, the agent keeps
            the mark generated from its name.
          </p>
        </div>
      </div>

      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />

      {preview && (
        <p className="font-mono text-[11px] text-bone-faint">
          {preview.width}&times;{preview.height} &middot; {(preview.bytes / 1024).toFixed(0)}KB &middot;{' '}
          {preview.mime.replace('image/', '')}
        </p>
      )}

      {error && <ErrorPanel title="That picture was not saved." detail={error} />}

      <p className="max-w-prose text-xs leading-relaxed text-bone-faint">
        This is how the agent looks in AI17Z. It does not change the profile picture of the X account it posts from —
        that stays a decision you make on X.
      </p>
    </div>
  );
}
