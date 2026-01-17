/**
 * Server-side console bridge endpoint factory
 */

import type { RequestHandler } from '@sveltejs/kit';
import { json, error } from '@sveltejs/kit';

export interface ConsoleBridgeServerOptions {
	prefix?: string;
	formatter?: (level: string, url: string, timestamp: string, args: any[]) => string;
	onLog?: (level: string, url: string, timestamp: string, args: any[]) => void;
}

const DEFAULT_OPTIONS: Required<ConsoleBridgeServerOptions> = {
	prefix: '[FRONTEND',
	formatter: (level, url, timestamp) =>
		`[FRONTEND ${level.toUpperCase()}] ${url} @ ${timestamp}`,
	onLog: () => {}
};

/**
 * Create a SvelteKit RequestHandler for console bridge endpoint
 * Use in your +server.ts: export const POST = createConsoleBridgeEndpoint();
 */
export function createConsoleBridgeEndpoint(
	userOptions: ConsoleBridgeServerOptions = {}
): RequestHandler {
	const options = { ...DEFAULT_OPTIONS, ...userOptions };

	return async ({ request }) => {
		// Only allow in dev mode
		if (import.meta.env.PROD) {
			throw error(404);
		}

		try {
			const body = await request.json();

			// Handle both single log and batch
			const logs = Array.isArray(body.batch) ? body.batch : [body];

			for (const log of logs) {
				const { level, args, timestamp, url, stack } = log;

				// Custom formatter or default
				const prefix = options.formatter(level, url, timestamp, args);

				// Prepare args for logging (include stack if present)
				const logArgs = stack ? [...args, `\nStack: ${stack}`] : args;

				// Log to console
				switch (level) {
					case 'error':
						console.error(prefix, ...logArgs);
						break;
					case 'warn':
						console.warn(prefix, ...logArgs);
						break;
					case 'info':
						console.info(prefix, ...logArgs);
						break;
					case 'debug':
						console.debug(prefix, ...logArgs);
						break;
					case 'network':
						console.info(prefix, ...logArgs);
						break;
					default:
						console.log(prefix, ...logArgs);
				}

				// Custom callback
				options.onLog(level, url, timestamp, args);
			}

			return json({ success: true });
		} catch (err) {
			console.error('[Console Bridge] Failed to process logs:', err);
			return json({ success: false }, { status: 400 });
		}
	};
}
