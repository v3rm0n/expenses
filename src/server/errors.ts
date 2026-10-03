export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function publicError(error: unknown): string {
  return error instanceof AppError
    ? error.message
    : "The operation could not be completed. You can retry from the application.";
}
