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
	loopThreshold?: number;
	loopWindow?: number;
	maxQueueSize?: number;
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
	networkInclude: [],
	loopThreshold: 10,
	loopWindow: 5000,
	maxQueueSize: 200
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

// Loop detection state
const recentMessages: Map<string, number[]> = new Map();
const suppressedKeys: Set<string> = new Set();
let sessionId = 0;

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

function getNetworkLevel(status: number): EventLevel {
	if (status === 0 || status >= 500) return 'error';
	if (status >= 400) return 'warn';
	return 'network';
}

function getLoopKey(entry: LogEntry): string {
	if (entry.kind === 'network') {
		// Include level so errors aren't suppressed by prior successful polling
		return `${entry.method ?? ''} ${entry.url} ${entry.level}`;
	}
	try {
		const first = entry.args?.[0];
		if (first === undefined || first === null) return '';
		const str = typeof first === 'string' ? first : JSON.stringify(first);
		return str.slice(0, 200);
	} catch {
		return '';
	}
}

function scheduleUnsuppress(key: string) {
	if (!options) return;
	const loopWindow = options.loopWindow;
	const threshold = options.loopThreshold;
	const currentSession = sessionId;

	setTimeout(() => {
		// Bail if session changed (restoreConsole + reinit)
		if (currentSession !== sessionId) return;

		const ts = recentMessages.get(key);
		const now = Date.now();
		const recent = ts?.filter((t) => t > now - loopWindow) ?? [];
		recentMessages.set(key, recent);
		if (recent.length < threshold) {
			suppressedKeys.delete(key);
			recentMessages.delete(key);
		} else {
			scheduleUnsuppress(key);
		}
	}, loopWindow);
}

/**
 * Returns true if this entry should be suppressed (loop detected).
 * Emits a single warning when a loop is first detected.
 */
function checkMessageLoop(entry: LogEntry): boolean {
	if (!options) return false;

	const key = getLoopKey(entry);
	if (!key) return false;

	const now = Date.now();
	const loopWindow = options.loopWindow;
	const threshold = options.loopThreshold;

	let timestamps = recentMessages.get(key);
	if (!timestamps) {
		// Evict oldest keys if map grows too large (100 max tracked keys)
		if (recentMessages.size >= 100) {
			const firstKey = recentMessages.keys().next().value;
			if (firstKey !== undefined) {
				recentMessages.delete(firstKey);
				suppressedKeys.delete(firstKey);
			}
		}
		timestamps = [];
		recentMessages.set(key, timestamps);
	}

	// Prune timestamps outside window
	const cutoff = now - loopWindow;
	while (timestamps.length > 0 && timestamps[0] < cutoff) {
		timestamps.shift();
	}

	timestamps.push(now);

	// Cap array to prevent unbounded growth during sustained loops
	if (timestamps.length > threshold * 2) {
		timestamps.splice(0, timestamps.length - threshold);
	}

	if (timestamps.length >= threshold) {
		if (!suppressedKeys.has(key)) {
			suppressedKeys.add(key);

			// Emit a single summary warning (use 'console' kind so server formats it as text)
			queueEntry({
				kind: 'console',
				level: 'warn',
				args: [
					`LOOP DETECTED: "${key.slice(0, 80)}" repeated ${timestamps.length} times in ${loopWindow / 1000}s — suppressing`
				],
				timestamp: new Date().toISOString(),
				url: entry.url ?? window.location.href,
				pageUrl: window.location.href
			});

			scheduleUnsuppress(key);
		}
		return true;
	}

	// Un-suppress if activity dropped below threshold
	if (suppressedKeys.has(key)) {
		suppressedKeys.delete(key);
	}

	return false;
}

function queueEntry(entry: LogEntry) {
	if (!dev || !browser || !options) return;

	// Enforce max queue size — drop oldest 10% when full
	if (logQueue.length >= options.maxQueueSize) {
		const dropCount = Math.max(1, Math.floor(options.maxQueueSize * 0.1));
		logQueue.splice(0, dropCount);
	}

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
					entry.stack = error.stack.slice(0, 1000);
				}
			}

			if (!checkMessageLoop(entry)) {
				queueEntry(entry);
			}
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

			const entry: LogEntry = {
				kind: 'network',
				level: getNetworkLevel(response.status),
				args: [`${method} ${resolvedUrl}`, `status: ${response.status}`, `duration: ${duration}ms`],
				timestamp: new Date().toISOString(),
				url: resolvedUrl,
				method,
				status: response.status,
				duration,
				requestType: 'fetch',
				pageUrl: window.location.href,
				responseBody
			};

			if (!checkMessageLoop(entry)) {
				queueEntry(entry);
			}

			return response;
		} catch (err) {
			const duration = Math.round(performance.now() - start);
			const message = err instanceof Error ? err.message : String(err);
			const stack = err instanceof Error && err.stack ? err.stack.slice(0, 1000) : undefined;

			const entry: LogEntry = {
				kind: 'network',
				level: 'error',
				args: [`${method} ${resolvedUrl}`, `error: ${message}`, `duration: ${duration}ms`],
				timestamp: new Date().toISOString(),
				url: resolvedUrl,
				method,
				status: 0,
				duration,
				requestType: 'fetch',
				pageUrl: window.location.href,
				stack
			};

			if (!checkMessageLoop(entry)) {
				queueEntry(entry);
			}

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

		const onDone = () => {
			this.removeEventListener('loadend', onDone);
			if (!meta || !resolvedUrl || !isNetworkTracked(resolvedUrl)) return;

			const duration = Math.round(performance.now() - meta.start);
			const status = this.status || 0;
			const responseBody = readXhrBody(this);

			const entry: LogEntry = {
				kind: 'network',
				level: getNetworkLevel(status),
				args: [`${meta.method} ${resolvedUrl}`, `status: ${status}`, `duration: ${duration}ms`],
				timestamp: new Date().toISOString(),
				url: resolvedUrl,
				method: meta.method,
				status,
				duration,
				requestType: 'xhr',
				pageUrl: window.location.href,
				responseBody
			};

			if (!checkMessageLoop(entry)) {
				queueEntry(entry);
			}
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

		const entry: LogEntry = {
			kind: 'error',
			level: 'error',
			args: [event.message],
			timestamp: new Date().toISOString(),
			url: event.filename ?? window.location.href,
			stack,
			pageUrl: window.location.href
		};

		if (!checkMessageLoop(entry)) {
			queueEntry(entry);
		}
	};

	rejectionHandler = (event) => {
		const reason = event.reason;
		const message = reason instanceof Error ? reason.message : String(reason);
		const stack = reason instanceof Error && reason.stack ? reason.stack.slice(0, 1000) : undefined;

		const entry: LogEntry = {
			kind: 'error',
			level: 'error',
			args: [message],
			timestamp: new Date().toISOString(),
			url: window.location.href,
			stack,
			pageUrl: window.location.href
		};

		if (!checkMessageLoop(entry)) {
			queueEntry(entry);
		}
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

	sessionId++;
	const merged = { ...DEFAULT_OPTIONS, ...userOptions };

	// Clamp to safe ranges to prevent DoS from zero/negative/NaN/Infinity values
	const safeInt = (v: number, min: number, max: number, fallback: number) =>
		Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback;
	merged.loopThreshold = safeInt(merged.loopThreshold, 2, 1000, DEFAULT_OPTIONS.loopThreshold);
	merged.loopWindow = safeInt(merged.loopWindow, 100, 60000, DEFAULT_OPTIONS.loopWindow);
	merged.maxQueueSize = safeInt(merged.maxQueueSize, 10, 10000, DEFAULT_OPTIONS.maxQueueSize);

	options = merged;

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
	if (!browser) return;
	sessionId++;
	console.log = originalConsole.log;
	console.warn = originalConsole.warn;
	console.error = originalConsole.error;
	console.info = originalConsole.info;
	console.debug = originalConsole.debug;
	restoreNetwork();
	detachErrorListeners();
	recentMessages.clear();
	suppressedKeys.clear();
	logQueue.length = 0;
	isSending = false;
	if (batchTimer) {
		clearTimeout(batchTimer);
		batchTimer = null;
	}
	options = null;
	isInitialized = false;
}
