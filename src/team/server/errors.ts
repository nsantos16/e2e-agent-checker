export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const forbidden = () =>
  new ApiError(
    403,
    'ACCESS_DENIED',
    'This account does not have access to this team.',
  );
