import { spawnSync } from 'node:child_process';

// ps is available on the supported macOS/Linux hosts. Keep ownership if the
// process table cannot be read; never assume that unknown children are gone.
export function hasGroupMembers(group) {
  const result = spawnSync('ps', ['-axo', 'pid=,pgid=,stat='], {
    encoding: 'utf8',
    detached: true,
    timeout: 1000,
  });
  if (result.error || result.status !== 0) return true;

  return result.stdout
    .trim()
    .split('\n')
    .some((line) => {
      const [pid, pgid, state] = line.trim().split(/\s+/);
      return (
        Number(pgid) === group &&
        Number(pid) !== process.pid &&
        !state.startsWith('Z')
      );
    });
}
