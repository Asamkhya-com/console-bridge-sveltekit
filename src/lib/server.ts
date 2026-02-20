/**
 * Server-side console bridge endpoint factory
 */

import type { RequestHandler } from '@sveltejs/kit';
import { json, error } from '@sveltejs/kit';

export interface NetworkLogData {
	method?: string;
	url: string;
	status?: number;
	duration?: number;
	responseBody?: string;
	requestType?: 'fetch' | 'xhr';
	level: string;
}

export interface ConsoleBridgeServerOptions {
	prefix?: string;
	formatter?: (level: string, url: string, timestamp: string, args: any[]) => string;
	onLog?: (level: string, url: string, timestamp: string, args: any[]) => void;
	networkFormatter?: (data: NetworkLogData) => string;
}

function sanitizeForLog(str: string): string {
	// Strip ANSI escapes, control chars, and newlines to prevent log line forgery
	return str
		.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
		.replace(/[\x00-\x1f\x7f]/g, ' ')
		.trim();
}

function defaultNetworkFormatter(data: NetworkLogData): string {
	const { method = 'GET', url, status, duration, responseBody } = data;

	let shortUrl = url;
	try {
		const parsed = new URL(url);
		shortUrl = parsed.pathname + parsed.search;
	} catch {
		// keep as-is
	}

	const statusStr = status === 0 ? 'NETWORK_ERROR' : String(status);
	const durationStr = duration !== undefined ? ` (${duration}ms)` : '';
	let line = `${method} ${shortUrl} \u2192 ${statusStr}${durationStr}`;

	if (status !== undefined && (status === 0 || status >= 400) && responseBody) {
		const sanitized = sanitizeForLog(responseBody);
		const truncated = sanitized.length > 200 ? sanitized.slice(0, 200) + '...' : sanitized;
		line += ` Body: ${truncated}`;
	}

	return line;
}

const DEFAULT_OPTIONS: Required<
	Pick<ConsoleBridgeServerOptions, 'prefix' | 'formatter' | 'onLog'>
> = {
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
	const networkFmt = userOptions.networkFormatter ?? defaultNetworkFormatter;

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
				const {
					kind,
					level,
					args,
					timestamp,
					url,
					stack,
					method,
					status,
					duration,
					responseBody,
					requestType
				} = log;

				// Network entries: use structured formatting
				if (kind === 'network') {
					const formatted = networkFmt({
						method,
						url,
						status,
						duration,
						responseBody,
						requestType,
						level
					});

					const netPrefix =
						level === 'error' || level === 'warn'
							? '[FRONTEND NET ERROR]'
							: '[FRONTEND NET]';

					const fullLine = `${netPrefix} ${formatted}`;

					if (level === 'error') {
						console.error(fullLine);
					} else if (level === 'warn') {
						console.warn(fullLine);
					} else {
						console.info(fullLine);
					}

					if (stack) {
						console.error(`  Stack: ${stack}`);
					}

					options.onLog(level, url, timestamp, args);
					continue;
				}

				// Console/error entries: existing formatting
				const prefix = options.formatter(level, url, timestamp, args);
				const logArgs = stack ? [...args, `\nStack: ${stack}`] : args;

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
					default:
						console.log(prefix, ...logArgs);
				}

				options.onLog(level, url, timestamp, args);
			}

			return json({ success: true });
		} catch (err) {
			console.error('[Console Bridge] Failed to process logs:', err);
			return json({ success: false }, { status: 400 });
		}
	};
}
