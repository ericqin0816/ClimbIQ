/** Small CDP request client with bounded waits and explicit connection failure. */
export function createProtocolClient(socket, { timeoutMs = 30000 } = {}) {
  let nextId = 0;
  let failure;
  const pending = new Map();

  function failConnection(error) {
    failure = error;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  }

  socket.addEventListener("close", () => failConnection(new Error("Browser debugging connection closed.")));
  socket.addEventListener("error", () => failConnection(new Error("Browser debugging connection failed.")));
  socket.addEventListener("message", event => {
    let message;
    try { message = JSON.parse(event.data); } catch {
      failConnection(new Error("Browser debugging connection returned invalid JSON."));
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
    else waiter.resolve(message.result);
  });

  return {
    send(method, params = {}) {
      if (failure) return Promise.reject(failure);
      if (socket.readyState !== 1) return Promise.reject(new Error("Browser debugging connection is not open."));
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Browser command ${method} timed out after ${timeoutMs} ms.`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, method });
        try { socket.send(JSON.stringify({ id, method, params })); } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    },
  };
}
