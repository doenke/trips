/** An error with a German message for the user, mapped to an HTTP status by the REST layer and to tool text by MCP. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Eintrag') => new AppError(404, 'not_found', `${what} nicht gefunden`);
export const forbidden = (message = 'Dafür fehlt dir die Berechtigung: Nur Reisende dieser Reise und Admins dürfen sie ändern.') =>
  new AppError(403, 'forbidden', message);
export const badRequest = (message: string) => new AppError(400, 'bad_request', message);
export const conflict = (message: string) => new AppError(409, 'conflict', message);

/** Who is acting. Every service call takes one; REST, MCP and the mail import all build it the same way. */
export interface Actor {
  userId: string;
  isAdmin: boolean;
}
