export type ErrorLike = {
	message: string;
};

export function Ok<T>(data: T) {
	return [null, data] as const;
}

export function Err<E extends ErrorLike>(error: E) {
	return [error, null] as const;
}

export type Result<T, E extends ErrorLike = Error> = ReturnType<typeof Ok<T>> | ReturnType<typeof Err<E>>;
