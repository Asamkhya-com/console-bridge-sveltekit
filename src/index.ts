// Re-export everything for convenience
export {
	initConsolebridge,
	restoreConsole,
	type ConsoleBridgeOptions
} from './lib/client.js';
export {
	createConsoleBridgeEndpoint,
	type ConsoleBridgeServerOptions
} from './lib/server.js';
