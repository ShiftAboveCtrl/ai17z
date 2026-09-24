import { AutonomyPanel } from '@app/components/AutonomyPanel';
import { Section } from './Section';

/**
 * What the agent does when nobody asked it to.
 *
 * Its own section rather than a corner of Behaviour, because the question an
 * owner brings here is different: Behaviour answers "what did it do", and this
 * answers "what is it allowed to do, and why is it not doing it". Those look
 * adjacent and are not, and the second one is the one people ask at three in
 * the afternoon when an account has gone quiet.
 */
export function AutonomySection({ index, agentId }: { index: number; agentId: string }) {
  return (
    <Section
      id="autonomy"
      index={index}
      eyebrow="Restraint"
      heading="What it does unasked."
      lede="Ceilings rather than targets. Nothing here tries to spend what is left, and none of it touches answering somebody who wrote in."
      explain={
        <>
          <p><strong>Going looking for people is the optional half of what an agent does</strong>, and it is the half that should be rare.</p>
          <p>Every number on this screen is a limit, not a goal. An agent that has used none of its allowance is behaving correctly, not falling behind.</p>
          <p>Answering a mention or a reply is not governed by any of it. Somebody who writes to your agent at three in the morning still gets an answer.</p>
        </>
      }
    >
      <AutonomyPanel agentId={agentId} />
    </Section>
  );
}
