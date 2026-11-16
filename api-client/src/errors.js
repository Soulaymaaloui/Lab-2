// Typed API errors keep retry logic, cancellations, and deadline failures easy to reason about.
// Callers can catch specific classes without matching on raw status codes or string messages.
export class ApiError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

/** The caller's AbortSignal fired. Nothing is left running. */
export class CancelledError extends ApiError {}

/** The total deadline (all attempts + backoff) ran out. */
export class DeadlineExceededError extends ApiError {
  constructor(deadlineMs, attempts) {
    super(`total deadline of ${deadlineMs} ms exceeded after ${attempts} attempt(s)`);
    this.deadlineMs = deadlineMs;
    this.attempts = attempts;
  }
}

/** Every allowed attempt failed with a retryable problem. */
export class RetryExhaustedError extends ApiError {
  constructor(attempts, lastFailure) {
    super(`gave up after ${attempts} attempt(s): ${lastFailure}`);
    this.attempts = attempts;
    this.lastFailure = lastFailure;
  }
}

/** A non-retryable HTTP status (e.g. 404). The Response is attached (body already released). */
export class HttpError extends ApiError {
  constructor(status, response) {
    super(`HTTP ${status}`);
    this.status = status;
    this.response = response;
  }
}

/** A failure we refused to retry because the request is not idempotent (POST/PATCH without key). */
export class NotRetryableError extends ApiError {
  constructor(method, lastFailure) {
    super(`${method} failed (${lastFailure}) and is not safe to retry without an idempotency key`);
    this.method = method;
    this.lastFailure = lastFailure;
  }
}
