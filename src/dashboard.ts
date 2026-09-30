import { spawn } from 'node:child_process';
import { release } from 'node:os';

/** Open a URL in the user's browser. Best effort: the URL is also printed. */
export function openBrowser(url: string): void {
  const wsl = process.platform === 'linux' && release().toLowerCase().includes('microsoft');
  const [command, args]: [string, string[]] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    // Under WSL the browser lives on Windows.
    : wsl ? ['powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url.replaceAll("'", "''")}'`]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* no browser available; the printed URL still works */ });
    child.unref();
  } catch { /* same */ }
}
