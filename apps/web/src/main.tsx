import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { SessionProvider } from '@app/lib/session';
import { Crash } from '@app/components/Crash';
import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

// Two boundaries, not one. The inner one in App keeps the header and the
// navigation standing when a single screen throws; this outer one exists for
// everything the inner one sits inside -- the session provider, the top bar,
// the router itself. Without it a fault in any of those is still a black
// screen, which is the failure mode this is here to end.
createRoot(container).render(
  <StrictMode>
    <Crash area="application">
      <BrowserRouter>
        <SessionProvider>
          <App />
        </SessionProvider>
      </BrowserRouter>
    </Crash>
  </StrictMode>,
);
