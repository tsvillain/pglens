/**
 * Zod request-validation middleware.
 *
 * Validates and replaces `req.body`, `req.query`, and `req.params` with
 * parsed values. On failure, returns a 400 with the error envelope plus a
 * `hint` listing the offending paths.
 */

const { sendError, codes } = require('./errors');

function formatIssues(issues) {
  return issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/**
 * @param {object} schemas - { body?, query?, params? } of zod schemas
 */
function validate(schemas) {
  return (req, res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) req.query = schemas.query.parse(req.query);
      if (schemas.params) req.params = schemas.params.parse(req.params);
      next();
    } catch (err) {
      if (err && err.issues) {
        return sendError(
          res,
          400,
          codes.VALIDATION,
          'Request failed validation',
          { hint: formatIssues(err.issues) },
        );
      }
      return sendError(res, 400, codes.BAD_REQUEST, err?.message || 'Bad request');
    }
  };
}

module.exports = { validate };
