// Wraps every method of an object (the cacheService or the repository) so that each
// call is counted in the metrics, without changing the wrapped code or its callers.
// The strategies receive the wrapped object and cannot tell the difference: this is
// the decorator pattern, applied in server.js where the dependencies are assembled.
//
// outcome(operation, result) classifies a successful call (e.g. 'hit', 'miss', 'ok').
// A call that throws is counted as 'error' and the error is re-thrown unchanged.
//
// Only counts for now. Timing each call here (process.hrtime.bigint() around the
// await) is the natural place to add per-component latency (Redis vs MongoDB) if the
// report needs it later.

function instrument(target, { component, metrics, outcome, skip = [] }) {
  const wrapped = {};
  for (const [name, value] of Object.entries(target)) {
    if (typeof value !== 'function' || skip.includes(name)) {
      wrapped[name] = value;
      continue;
    }
    wrapped[name] = async (...args) => {
      let result;
      try {
        result = await value.apply(target, args);
      } catch (err) {
        metrics.recordCall(component, name, 'error');
        throw err;
      }
      metrics.recordCall(component, name, outcome(name, result));
      return result;
    };
  }
  return wrapped;
}

// The cacheService never throws: it reports failures in its return value.
//   get -> { status: 'hit' | 'miss' | 'error' }
//   set / del -> true | false      incr -> number | null
function cacheOutcome(operation, result) {
  if (operation === 'get') return result.status;
  return result === false || result === null ? 'error' : 'ok';
}

// The repository throws on failure; any returned value (even null = not found) is a
// query MongoDB actually answered.
function sourceOutcome() {
  return 'ok';
}

module.exports = { instrument, cacheOutcome, sourceOutcome };
