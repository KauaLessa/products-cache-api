// Counts every request by route, status code and X-Cache result, once the response
// has been sent ('finish' event). It reads the X-Cache header the controller already
// sets, so neither the controller nor the strategies know that metrics exist.
//
// The route is the template ("GET /products/:id"), never the raw URL: one entry per
// endpoint instead of one per product id. Requests that match no route are grouped
// as "unmatched".
//
// /metrics and /health are not counted: they are monitoring, not workload, and
// GET /metrics would otherwise count itself.

const EXCLUDED_PREFIXES = ['/metrics', '/health'];

// req.baseUrl ("/products") is only reliable while the request is inside its router:
// when a handler throws, Express leaves the router and resets it to "" before the
// error handler answers. So the mount path is derived from the URL instead: drop from
// the URL as many trailing segments as the route template has.
//   "/products/42" + route "/:id" -> mount "/products" -> "GET /products/:id"
function routeLabel(req) {
  if (!req.route) return 'unmatched';
  const routePath = req.route.path === '/' ? '' : req.route.path;
  const routeSegments = routePath.split('/').filter(Boolean).length;
  const urlSegments = req.originalUrl.split('?')[0].split('/').filter(Boolean);
  const mount = urlSegments.slice(0, urlSegments.length - routeSegments).join('/');
  return `${req.method} /${mount}${routePath}`;
}

function requestMetrics(metrics) {
  return (req, res, next) => {
    if (EXCLUDED_PREFIXES.some((prefix) => req.path.startsWith(prefix))) return next();
    res.on('finish', () => {
      metrics.recordRequest(routeLabel(req), res.statusCode, res.get('X-Cache'));
    });
    next();
  };
}

module.exports = requestMetrics;
