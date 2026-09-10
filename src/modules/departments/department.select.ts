/**
 * The department shape embedded in a user payload.
 *
 * It lives in its own module so `auth.service` can nest it inside
 * `publicUserSelect` without importing `department.service`, which imports
 * `publicUserSelect` back — a require cycle that would leave one of the two
 * constants `undefined` at module-evaluation time.
 */
export const departmentSummarySelect = {
  id: true,
  name: true,
  code: true,
} as const;
