import { expect, it } from 'vitest';
import { act, create } from 'react-test-renderer';
import { EvidenceCardControl } from '../../apps/web/src/components/EvidenceCardControl';

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
