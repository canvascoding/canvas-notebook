/** Own request-stream errors throughout framework setup and teardown. */
function guardHttpRequestLifecycle(req, res, reportError = console.error) {
  req.on('error', (error) => {
    // Node emits this asynchronously when the peer closes an incomplete
    // request. Framework cleanup may already have removed its own listeners.
    if (!(req.aborted && error.code === 'ECONNRESET')) {
      reportError('[HTTP] Request stream failed:', error);
    }
    if (!res.destroyed) res.destroy();
  });
}

module.exports = { guardHttpRequestLifecycle };
