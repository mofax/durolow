import Pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';

export function createLogger(name: string) {
	const logger = Pino({
		transport: isProd
			? undefined
			: {
					target: 'pino-pretty',
					options: {
						colorize: true,
					},
				},
	});
	return logger.child({ name });
}

export const logger = createLogger('default');
