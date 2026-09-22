import { useEffect } from 'react';

const APP_NAME = 'SAMTEC';

/** Puts the page's name in the browser tab, for example "Employees · SAMTEC". */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · ${APP_NAME}`;
    return () => {
      document.title = `${APP_NAME} · Attendance & Payroll`;
    };
  }, [title]);
}
