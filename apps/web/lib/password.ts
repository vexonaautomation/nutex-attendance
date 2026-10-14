/** mirror of the server rule (packages/validation passwordProblem) so the form can explain a problem before it submits */
export const PASSWORD_MIN_LENGTH = 8;

export function passwordProblem(password: string, username = ''): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (!/[a-z]/i.test(password) || !/\d/.test(password)) return 'Password must contain both letters and digits';
  if (username && password.toLowerCase() === username.toLowerCase()) return 'Password must not be the same as the username';
  return null;
}
