let sequence = 0;
const pending = new Map<
  string,
  {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.data?.type !== "orca-panel-action-result") return;
  const request = pending.get(event.data.requestId);
  if (!request) return;
  pending.delete(event.data.requestId);
  clearTimeout(request.timer);
  event.data.ok
    ? request.resolve(event.data.value)
    : request.reject(new Error(event.data.error || "Orca action failed"));
});
export function hostCall(action: string, params: unknown): Promise<unknown> {
  if (pending.size >= 8)
    return Promise.reject(new Error("Wait for the current requests to finish"));
  const requestId = `cv-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("Action timed out. Check its status before retrying"));
    }, 35000);
    pending.set(requestId, { resolve, reject, timer });
    window.parent.postMessage({ type: "orca-panel-action", requestId, action, params }, "*");
  });
}
export const command = (name: string, args: unknown = {}) =>
  hostCall("commands.invokeOwn", { commandId: `cvhub.${name}`, args });
