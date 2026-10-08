import './styles.css';
import { Session } from './session';
import { App } from './ui/app';

const session = new Session();
new App(session).mount();

// Exposed for diagnostics and the end-to-end tests.
(globalThis as unknown as { __jam: unknown }).__jam = {
  session,
  isolated: globalThis.crossOriginIsolated === true,
};
