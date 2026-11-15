import { expect, it } from 'vitest';
import { act, create } from 'react-test-renderer';
import { EvidenceCardControl } from '../../apps/web/src/components/EvidenceCardControl';
import { EvidenceCardLinkControl } from '../../apps/web/src/components/EvidenceCardLinkControl';
import { EvidenceFollowUpControl } from '../../apps/web/src/components/EvidenceFollowUpControl';

it('shows the actual owner setting as an accessible switch and returns the explicit new choice', () => {
  let value = false;
  const render = create(<EvidenceCardControl checked={value} onChange={v => { value = v; }} />);
  const control = render.root.findByProps({ role: 'switch' });
  expect(control.props['aria-checked']).toBe(false);
  expect(JSON.stringify(render.toJSON())).toContain('Off by default');
  act(() => control.props.onClick());
  expect(value).toBe(true);
  act(() => render.update(<EvidenceCardControl checked={value} onChange={v => { value = v; }} />));
  expect(render.root.findByProps({ role: 'switch' }).props['aria-checked']).toBe(true);
});

it('offers the check page link as its own switch, off by default, returning the explicit choice', () => {
  let value = false;
  const render = create(<EvidenceCardLinkControl checked={value} onChange={v => { value = v; }} />);
  const control = render.root.findByProps({ role: 'switch' });
  expect(control.props['aria-checked']).toBe(false);
  expect(JSON.stringify(render.toJSON())).toContain('Off by default');
  act(() => control.props.onClick());
  expect(value).toBe(true);
});

it('offers evidence follow-ups as their own switch, off by default, saying it needs a confirmed watch and sends nothing without Studio', () => {
  let value = false;
  const render = create(<EvidenceFollowUpControl checked={value} onChange={v => { value = v; }} />);
  const control = render.root.findByProps({ role: 'switch' });
  expect(control.props['aria-checked']).toBe(false);
  const shown = JSON.stringify(render.toJSON());
  expect(shown).toContain('Off by default');
  expect(shown).toContain('you confirmed yourself');
  expect(shown).toContain('nothing is sent if Studio cannot be reached');
  act(() => control.props.onClick());
  expect(value).toBe(true);
});
