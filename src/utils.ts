/**
 * This function enables the exhaustive check.
 * It works by returning `never`, and accepting the first param as `never`
 * @param value The type that we're checking
 * @param message A message to display if it errors
 * @param lastWords A callback to call before the error
 */
export function assertUnreachable(
    value: never,
    message?: string,
    lastWords?: () => void
): never {
    if (lastWords) lastWords();
    throw {
        message:
            message ||
            "Invariant unreachable type error. Something isn't right!",
    };
}
