import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { DevUpdatesPage } from '../../../apps/web/src/routes/DevUpdatesPage';
import { TokenReveal } from '../../../apps/web/src/routes/devUpdates/TokenReveal';
import { setTransport } from '../../../apps/web/src/lib/transport';
import '../../../apps/web/src/styles.css';

const hosted = new URLSearchParams(window.location.search).has('hosted');
if (hosted) setTransport({ mode: 'HOSTED', base: 'https://gateway.example.invalid', grant: 'test-grant' });

function Harness() {
  const navigate = useNavigate();
  const location = useLocation();
  return <>
    <button onClick={() => navigate(`${location.pathname}?marker=current`)}>Change search</button>
    <output data-testid="search">{location.search}</output>
    {hosted ? <TokenReveal token={`ai17z_dus_${'a'.repeat(24)}`} projectKey="demo" projectName="Demo"
      connection={{ serverName: 'ai17z-dev-updates', mcpServerPath: '/opt/ai17z/tools/dev-updates-mcp.mjs', reason: null }}
      connectionError={null} onDone={() => undefined} /> : <DevUpdatesPage />}
  </>;
}

createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={['/dev-updates']}><Harness /></MemoryRouter>);
