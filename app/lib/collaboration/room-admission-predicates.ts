/** Fixed SQL expressions shared by fresh admission observations. These select
 * reservations only; they never acquire a lock or grant read/write authority. */
const matchesPath = (path: '$2' | 'header.path') => `(s.path = ${path} OR (s.kind = 'subtree'
  AND (s.path = '' OR left(${path}, length(s.path) + 1) = s.path || '/')))`;

export const collaborationAdmissionReadPredicates = Object.freeze({
  activeRequest: "r.status NOT IN ('committed', 'cancelled')",
  parameterPath: matchesPath('$2'),
  observedHeaderPath: matchesPath('header.path'),
});
