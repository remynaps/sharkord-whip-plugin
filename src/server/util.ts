// Some fun helper methods
export function addOnceListener(target: any, event: string, handler: () => void) {
  if (!target) return;
  if (typeof target.once === 'function') {
    target.once(event, handler);
  } else if (typeof target.on === 'function') {
    target.on(event, handler);
  }
}

export function corsResponse(res: Response): Response {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Methods', 'POST, DELETE, GET, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.headers.set('Access-Control-Expose-Headers', 'Location');
  return res;
}