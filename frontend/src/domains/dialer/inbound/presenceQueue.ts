export function createPresenceQueue(send: (online: boolean) => Promise<void>) {
  let tail = Promise.resolve();
  return (online: boolean, isCurrent: () => boolean): Promise<boolean> => {
    const result = tail.then(async () => {
      if (online && !isCurrent()) return false;
      await send(online);
      return true;
    });
    // Keep later releases runnable after a failure; the caller handles the error.
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}
