/**
 * Client-side console bridge for SvelteKit
 * Intercepts console methods and forwards logs to backend
 */

import { browser, dev } from '$app/environment';

export interface ConsoleBridgeOptions {
	endpoint?: string;
	batchSize?: number;
	batchDelay?: number;
	levels?: LogLevel[];
	captureNetwork?: boolean;
	captureErrors?: boolean;
	networkBodyLimit?: number;
	networkIgnore?: (string | RegExp)[];
	networkInclude?: (string | RegExp)[];
}

type LogLevel = 'log' | 'warn' | 'error' | 'info' | 'debug';

type EventLevel = LogLevel | 'network';
type LogKind = 'console' | 'network' | 'error';

type LogEntry = {
	kind: LogKind;
	level: EventLevel;
	args: any[];
	timestamp: string;
	url: string;
	stack?: string;
	method?: string;
	status?: number;
	duration?: number;
	requestType?: 'fetch' | 'xhr';
	pageUrl?: string;
	responseBody?: string;
};

const DEFAULT_OPTIONS: Required<ConsoleBridgeOptions> = {
	endpoint: '/api/console-bridge',
	batchSize: 10,
	batchDelay: 100,
	levels: ['log', 'warn', 'error', 'info', 'debug'],
	captureNetwork: true,
	captureErrors: true,
	networkBodyLimit: 500,
	networkIgnore: [],
	networkInclude: []
};

let isSending = false;
let logQueue: LogEntry[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let options: Required<ConsoleBridgeOptions> | null = null;
let isInitialized = false;
let networkPatched = false;
let errorListenersAttached = false;

let originalFetch: typeof fetch | null = null;
let originalXhrOpen: typeof XMLHttpRequest.prototype.open | null = null;
let originalXhrSend: typeof XMLHttpRequest.prototype.send | null = null;

let errorHandler: ((event: ErrorEvent) => void) | null = null;
let rejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;

const xhrMeta = new WeakMap<XMLHttpRequest, { method: string; url: string; start: number }>();

// Store original console methods
const originalConsole = {
	log: console.log,
	warn: console.warn,
	error: console.error,
	info: console.info,
	debug: console.debug
};

function resolveUrl(input: string) {
	try {
		return new URL(input, window.location.href).toString();
	} catch {
		return input;
	}
}

function matchesPattern(value: string, pattern: string | RegExp) {
	if (pattern instanceof RegExp) return pattern.test(value);
	return value.includes(pattern);
}

function isNetworkTracked(targetUrl: string) {
	if (!options) return false;
	const resolved = resolveUrl(targetUrl);

	if (resolved === resolveUrl(options.endpoint)) return false;

	if (options.networkIgnore.some((pattern) => matchesPattern(resolved, pattern))) {
		return false;
	}

	if (options.networkInclude.length > 0) {
		return options.networkInclude.some((pattern) => matchesPattern(resolved, pattern));
	}

	return true;
}

function queueEntry(entry: LogEntry) {
	if (!dev || !browser || !options) return;
	if (isSending) return;
	logQueue.push(entry);
	scheduleBatch();
}

function sendBatch() {
	if (!options || isSending || logQueue.length === 0) return;

	isSending = true;
	const batch = logQueue.splice(0, options.batchSize);
	const sender = originalFetch ?? fetch;

	sender(options.endpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(batch.length === 1 ? batch[0] : { batch })
	})
		.catch((err) => {
			originalConsole.error('[Console Bridge] Failed to send logs:', err);
		})
		.finally(() => {
			isSending = false;
			if (logQueue.length > 0) {
				scheduleBatch();
			}
		});
}

function scheduleBatch() {
	if (!options || batchTimer) return;
	batchTimer = setTimeout(() => {
		batchTimer = null;
		sendBatch();
	}, options.batchDelay);
}

function createInterceptor(level: LogLevel) {
	return function (...args: any[]) {
		originalConsole[level](...args);

		if (dev && browser && options?.levels.includes(level)) {
			const entry: LogEntry = {
				kind: 'console',
				level,
				args,
				timestamp: new Date().toISOString(),
				url: window.location.href
			};

			// Capture stack trace for errors
			if (level === 'error' && args[0] instanceof Error) {
				const error = args[0];
				if (error.stack) {
					// Truncate to prevent huge payloads
					entry.stack = error.stack.slice(0, 1000);
				}
			}

			queueEntry(entry);
		}
	};
}

function getFetchDetails(args: Parameters<typeof fetch>) {
	const [input, init] = args;

	if (input instanceof Request) {
		return { method: input.method ?? 'GET', url: input.url };
	}

	const url = typeof input === 'string' || input instanceof URL ? input.toString() : String(input);
	return { method: init?.method ?? 'GET', url };
}

async function readResponseBody(response: Response) {
	if (!options || options.networkBodyLimit <= 0) return undefined;

	try {
		const clone = response.clone();
		const text = await clone.text();
		return text.slice(0, options.networkBodyLimit);
	} catch {
		return undefined;
	}
}

function readXhrBody(xhr: XMLHttpRequest) {
	if (!options || options.networkBodyLimit <= 0) return undefined;

	try {
		if (xhr.responseType && xhr.responseType !== 'text') return undefined;
		const text = typeof xhr.responseText === 'string' ? xhr.responseText : '';
		return text.slice(0, options.networkBodyLimit);
	} catch {
		return undefined;
	}
}

function patchFetch() {
	if (!('fetch' in window)) return;
	if (!originalFetch) originalFetch = window.fetch.bind(window);

	window.fetch = (async (...args: Parameters<typeof fetch>) => {
		const [input, init] = args;
		const { method, url } = getFetchDetails(args);
		const resolvedUrl = resolveUrl(url);

		if (!isNetworkTracked(resolvedUrl)) {
			return originalFetch!.call(window, input, init);
		}

		const start = performance.now();

		try {
			const response = await originalFetch!.call(window, input, init);
			const duration = Math.round(performance.now() - start);
			const responseBody = await readResponseBody(response);

			queueEntry({
				kind: 'network',
				level: 'network',
				args: [`${method} ${resolvedUrl}`, `status: ${response.status}`, `duration: ${duration}ms`],
				timestamp: new Date().toISOString(),
				url: resolvedUrl,
				method,
				status: response.status,
				duration,
				requestType: 'fetch',
				pageUrl: window.location.href,
				responseBody
			});

			return response;
		} catch (err) {
			const duration = Math.round(performance.now() - start);
			const message = err instanceof Error ? err.message : String(err);
			const stack = err instanceof Error && err.stack ? err.stack.slice(0, 1000) : undefined;

			queueEntry({
				kind: 'network',
				level: 'network',
				args: [`${method} ${resolvedUrl}`, `error: ${message}`, `duration: ${duration}ms`],
				timestamp: new Date().toISOString(),
				url: resolvedUrl,
				method,
				status: 0,
				duration,
				requestType: 'fetch',
				pageUrl: window.location.href,
				stack
			});

			throw err;
		}
	}) as typeof fetch;
}

function patchXhr() {
	if (!('XMLHttpRequest' in window)) return;
	if (!originalXhrOpen) originalXhrOpen = XMLHttpRequest.prototype.open;
	if (!originalXhrSend) originalXhrSend = XMLHttpRequest.prototype.send;

	XMLHttpRequest.prototype.open = function (method: string, url: string, ...rest: any[]) {
		xhrMeta.set(this, { method, url, start: 0 });
		return (originalXhrOpen as any).apply(this, [method, url, ...rest]);
	};

	XMLHttpRequest.prototype.send = function (...args: any[]) {
		const meta = xhrMeta.get(this);
		if (meta) meta.start = performance.now();

		const resolvedUrl = meta ? resolveUrl(meta.url) : '';

		const onDone = async () => {
			this.removeEventListener('loadend', onDone);
			if (!meta || !resolvedUrl || !isNetworkTracked(resolvedUrl)) return;

			const duration = Math.round(performance.now() - meta.start);
			const status = this.status || 0;
			const responseBody = await readXhrBody(this);

			queueEntry({
				kind: 'network',
				level: 'network',
				args: [`${meta.method} ${resolvedUrl}`, `status: ${status}`, `duration: ${duration}ms`],
				timestamp: new Date().toISOString(),
				url: resolvedUrl,
				method: meta.method,
				status,
				duration,
				requestType: 'xhr',
				pageUrl: window.location.href,
				responseBody
			});
		};

		this.addEventListener('loadend', onDone);
		const body = args[0] as Document | XMLHttpRequestBodyInit | null | undefined;
		return originalXhrSend!.call(this, body);
	};
}

function restoreNetwork() {
	if (!networkPatched) return;
	if (originalFetch) window.fetch = originalFetch;
	if (originalXhrOpen) XMLHttpRequest.prototype.open = originalXhrOpen;
	if (originalXhrSend) XMLHttpRequest.prototype.send = originalXhrSend;
	networkPatched = false;
}

function patchNetwork() {
	if (networkPatched) return;
	networkPatched = true;
	patchFetch();
	patchXhr();
}

function attachErrorListeners() {
	if (errorListenersAttached) return;
	errorListenersAttached = true;

	errorHandler = (event) => {
		const stack = event.error?.stack ? event.error.stack.slice(0, 1000) : undefined;

		queueEntry({
			kind: 'error',
			level: 'error',
			args: [event.message],
			timestamp: new Date().toISOString(),
			url: event.filename ?? window.location.href,
			stack,
			pageUrl: window.location.href
		});
	};

	rejectionHandler = (event) => {
		const reason = event.reason;
		const message = reason instanceof Error ? reason.message : String(reason);
		const stack = reason instanceof Error && reason.stack ? reason.stack.slice(0, 1000) : undefined;

		queueEntry({
			kind: 'error',
			level: 'error',
			args: [message],
			timestamp: new Date().toISOString(),
			url: window.location.href,
			stack,
			pageUrl: window.location.href
		});
	};

	window.addEventListener('error', errorHandler);
	window.addEventListener('unhandledrejection', rejectionHandler);
}

function detachErrorListeners() {
	if (!errorListenersAttached) return;
	errorListenersAttached = false;

	if (errorHandler) window.removeEventListener('error', errorHandler);
	if (rejectionHandler) window.removeEventListener('unhandledrejection', rejectionHandler);
	errorHandler = null;
	rejectionHandler = null;
}

/**
 * Initialize console bridge
 * Call this in your root +layout.svelte onMount()
 */
export function initConsolebridge(userOptions: ConsoleBridgeOptions = {}) {
	if (!browser || !dev) return;

	options = { ...DEFAULT_OPTIONS, ...userOptions };

	// Intercept only specified levels
	if (options.levels.includes('log')) console.log = createInterceptor('log');
	if (options.levels.includes('warn')) console.warn = createInterceptor('warn');
	if (options.levels.includes('error')) console.error = createInterceptor('error');
	if (options.levels.includes('info')) console.info = createInterceptor('info');
	if (options.levels.includes('debug')) console.debug = createInterceptor('debug');

	if (options.captureNetwork) {
		patchNetwork();
	} else {
		restoreNetwork();
	}

	if (options.captureErrors) {
		attachErrorListeners();
	} else {
		detachErrorListeners();
	}

	if (!isInitialized) {
		isInitialized = true;
		originalConsole.info(`[Console Bridge] Active - logs forwarded to ${options.endpoint}`);
	}
}

/**
 * Restore original console methods
 */
export function restoreConsole() {
	console.log = originalConsole.log;
	console.warn = originalConsole.warn;
	console.error = originalConsole.error;
	console.info = originalConsole.info;
	console.debug = originalConsole.debug;
	restoreNetwork();
	detachErrorListeners();
	options = null;
	isInitialized = false;
}
