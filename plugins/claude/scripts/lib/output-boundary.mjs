// Forward output through the ordered boundary, then drain surviving helpers.
export function forwardUntilBoundary(source, destination, marker) {
  return new Promise((resolve) => {
    let pending = '';
    let complete = false;
    source.setEncoding('utf8').on('data', (chunk) => {
      if (complete) return;

      pending += chunk;
      const index = pending.indexOf(marker);
      if (index !== -1) {
        complete = true;
        destination.end(pending.slice(0, index), resolve);
        pending = '';
        return;
      }

      let keep = Math.min(pending.length, marker.length - 1);
      while (keep && !marker.startsWith(pending.slice(-keep))) keep--;

      const end = pending.length - keep;
      if (!destination.write(pending.slice(0, end))) {
        source.pause();
        destination.once('drain', () => source.resume());
      }

      pending = pending.slice(end);
    });
  });
}
