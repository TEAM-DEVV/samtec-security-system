import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app';
import '@/kiosk.css';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('The kiosk has no root element to draw into.');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
